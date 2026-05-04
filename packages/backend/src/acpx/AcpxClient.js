import { randomUUID } from 'node:crypto';

const DEFAULT_TIMEOUT_MS = Number(process.env.OPENCLAW_ACPX_TIMEOUT_MS || 15000);

export class AcpxClient {
  constructor({
    baseUrl = process.env.OPENCLAW_ACPX_BASE_URL || process.env.OPENCLAW_BASE_URL || 'http://127.0.0.1:18789',
    apiKey = process.env.OPENCLAW_ACPX_API_KEY || process.env.OPENCLAW_GATEWAY_TOKEN || process.env.OPENCLAW_API_KEY || '',
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = globalThis.fetch,
  } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
    this.sessionChatCapability = null;
  }

  async health() {
    return this.#request('/health', { method: 'GET' });
  }

  async ensureSession({ sessionKey, label, model }) {
    try {
      return await this.#request('/acp/sessions', {
        method: 'POST',
        body: JSON.stringify({ sessionKey, label, model }),
      });
    } catch (error) {
      // Some ACPX deployments do not expose an explicit session-create endpoint.
      // In that case, session will be created lazily on first dispatch.
      if (Number(error?.status) === 404) {
        return {
          ok: true,
          key: sessionKey,
          mode: 'acpx-create-noop',
          note: 'acp/sessions endpoint not found; session creation deferred to first message',
        };
      }
      throw error;
    }
  }

  async supportsSessionChat() {
    if (this.sessionChatCapability !== null) {
      return this.sessionChatCapability;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/acp/sessions`, {
        method: 'GET',
        signal: controller.signal,
        headers: {
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
      });
      const contentType = String(res.headers.get('content-type') || '').toLowerCase();
      this.sessionChatCapability = res.ok && contentType.includes('application/json');
      return this.sessionChatCapability;
    } catch {
      this.sessionChatCapability = false;
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  async submitConversation({ taskId, prompt, sessionType, metadata = {}, callbackBaseUrl }) {
    const response = await this.#request('/acp/runs', {
      method: 'POST',
      body: JSON.stringify({
        taskId: taskId || randomUUID(),
        id: taskId || randomUUID(),
        runId: metadata.runId || `run:${taskId || randomUUID()}`,
        prompt,
        runtime: sessionType || 'openclaw',
        sessionKey: metadata.sessionKey || taskId,
        metadata,
        callbackBaseUrl,
      }),
    });
    return {
      upstreamTaskId: response?.run?.runId || response?.run?.taskId || taskId,
      status: response?.run?.status || 'accepted',
      raw: response,
    };
  }

  async sendSessionMessage({ sessionKey, message, deliver = false, target }) {
    const dispatchTarget = String(target || '').trim() || (deliver ? 'both' : 'local');
    try {
      return await this.#request(`/acp/sessions/${encodeURIComponent(sessionKey)}/dispatch`, {
        method: 'POST',
        body: JSON.stringify({
          message,
          target: dispatchTarget,
          openclawMode: 'run',
        }),
      });
    } catch (error) {
      // Compatibility fallback for ACPX deployments without session dispatch endpoint.
      // Route message through run API while preserving session key.
      if (Number(error?.status) === 404) {
        try {
          return await this.submitConversation({
            taskId: randomUUID(),
            prompt: String(message || ''),
            sessionType: 'openclaw',
            metadata: {
              sessionKey,
              source: 'session-dispatch-fallback',
            },
          });
        } catch (fallbackError) {
          if (Number(fallbackError?.status) === 404) {
            return {
              ok: false,
              unsupported: true,
              status: 'unsupported',
              message: 'ACPX chat endpoints are unavailable on current upstream',
            };
          }
          throw fallbackError;
        }
      }
      throw error;
    }
  }

  async injectSessionMessage({ sessionKey, message, label }) {
    return this.#request('/bridge/openclaw/channel/events', {
      method: 'POST',
      body: JSON.stringify({
        source: 'acpx',
        event: {
          type: 'session.message',
          sessionKey,
          message: { content: message, role: 'assistant', text: message },
          metadata: { label },
        },
      }),
    });
  }

  async getSessionHistory({ sessionKey, limit = 50 }) {
    return this.#request(`/acp/sessions/${encodeURIComponent(sessionKey)}`, {
      method: 'GET',
    }).then((data) => {
      const messages = Array.isArray(data?.session?.messages)
        ? data.session.messages.slice(0, limit).map((msg) => ({
          role: msg.role || 'assistant',
          content: msg.content || '',
          __openclaw: { seq: 0, id: msg.id || randomUUID() },
        }))
        : (data?.session?.runs?.slice(0, limit).map((run) => ({
          role: 'user',
          content: run.answerText || run.prompt || '',
          __openclaw: { seq: 0, id: run.runId },
        })) || []);
      return { messages };
    });
  }

  async abortSession({ sessionKey, runId }) {
    return this.#request(`/acp/runs/${encodeURIComponent(runId || sessionKey)}/terminate`, {
      method: 'POST',
    });
  }

  async getWsSessionSnapshots() {
    return new Map();
  }

  async #request(path, init) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
          ...(init?.headers || {}),
        },
      });
      const text = await res.text();
      let data = {};
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = { raw: text };
        }
      }
      if (!res.ok) {
        const detail = typeof data?.error === 'string'
          ? data.error
          : typeof data?.raw === 'string'
            ? data.raw
            : '';
        const err = new Error(`ACPX request failed: ${res.status}${detail ? ` - ${detail}` : ''}`);
        err.status = res.status;
        err.payload = data;
        throw err;
      }
      return data;
    } finally {
      clearTimeout(timer);
    }
  }
}
