import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const DEFAULT_TIMEOUT_MS = Number(process.env.OPENCLAW_TIMEOUT_MS || 15000);
const DEFAULT_API_KEY = process.env.OPENCLAW_GATEWAY_TOKEN || process.env.OPENCLAW_API_KEY || '';
const execFileAsync = promisify(execFile);
const DEFAULT_WS_SCOPE = [
  'operator.admin',
  'operator.read',
  'operator.write',
  'operator.approvals',
  'operator.pairing',
];

export class OpenClawClient {
  constructor({
    baseUrl = process.env.OPENCLAW_BASE_URL || 'http://127.0.0.1:18789',
    submitPath = process.env.OPENCLAW_SUBMIT_PATH || '/api/tasks',
    callbackPath = process.env.OPENCLAW_CALLBACK_PATH || '/callbacks/openclaw',
    apiKey = DEFAULT_API_KEY,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = globalThis.fetch,
    transport = process.env.OPENCLAW_TRANSPORT || 'auto',
    gatewayCallImpl = null,
  } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.submitPath = submitPath;
    this.callbackPath = callbackPath;
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
    this.transport = transport;
    this.gatewayCallImpl = gatewayCallImpl;
    this.wsUrl = process.env.OPENCLAW_WS_URL || this.#toWsUrl(this.baseUrl);
    this.wsRole = process.env.OPENCLAW_WS_ROLE || 'operator';
    this.wsScopes = (process.env.OPENCLAW_WS_SCOPES || DEFAULT_WS_SCOPE.join(','))
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
  }

  async submitConversation({ taskId, prompt, sessionType, metadata = {}, callbackBaseUrl }) {
    const callbackUrl = callbackBaseUrl
      ? `${callbackBaseUrl.replace(/\/+$/, '')}${this.callbackPath}`
      : undefined;

    if (this.#shouldUseWs()) {
      const wsResponse = await this.#callGateway('chat.send', {
        sessionKey: metadata.sessionKey || taskId,
        message: prompt,
        deliver: false,
        idempotencyKey: randomUUID(),
      });

      return {
        upstreamTaskId: wsResponse?.runId || wsResponse?.id || taskId,
        status: 'accepted',
        raw: wsResponse,
        callbackUrl,
      };
    }

    const body = {
      task_id: taskId,
      prompt,
      session_type: sessionType,
      metadata,
      callback_url: callbackUrl,
    };

    const response = await this.#request(this.submitPath, {
      method: 'POST',
      body: JSON.stringify(body),
    });

    return {
      upstreamTaskId: response.task_id || response.id || null,
      status: response.status || 'accepted',
      raw: response,
    };
  }

  async health() {
    return this.#request('/health', { method: 'GET' });
  }

  async ensureSession({ sessionKey, label, model }) {
    if (!this.#shouldUseWs()) {
      return {
        ok: true,
        key: sessionKey,
        mode: 'http-noop',
      };
    }
    return this.#callGateway('sessions.create', {
      key: sessionKey,
      ...(label ? { label } : {}),
      ...(model ? { model } : {}),
    });
  }

  async sendSessionMessage({ sessionKey, message, deliver = false, idempotencyKey = randomUUID() }) {
    if (!this.#shouldUseWs()) {
      throw new Error('sendSessionMessage requires gateway websocket transport');
    }
    return this.#callGateway('chat.send', {
      sessionKey,
      message,
      deliver,
      idempotencyKey,
    });
  }

  async injectSessionMessage({ sessionKey, message, label }) {
    if (!this.#shouldUseWs()) {
      throw new Error('injectSessionMessage requires gateway websocket transport');
    }
    return this.#callGateway('chat.inject', {
      sessionKey,
      message,
      ...(label ? { label } : {}),
    });
  }

  async getSessionHistory({ sessionKey, limit = 50 }) {
    if (!this.#shouldUseWs()) {
      throw new Error('getSessionHistory requires gateway websocket transport');
    }
    return this.#callGateway('chat.history', {
      sessionKey,
      limit,
    });
  }

  async abortSession({ sessionKey, runId }) {
    if (!this.#shouldUseWs()) {
      throw new Error('abortSession requires gateway websocket transport');
    }
    return this.#callGateway('chat.abort', {
      sessionKey,
      ...(runId ? { runId } : {}),
    });
  }

  async getWsSessionSnapshots() {
    if (!this.#shouldUseWs()) return new Map();
    const status = await this.#callGateway('status', {});
    const recent = Array.isArray(status?.sessions?.recent) ? status.sessions.recent : [];
    const bySessionKey = new Map();
    for (const item of recent) {
      const normalized = this.#normalizeSessionKey(item?.key);
      if (!normalized) continue;
      bySessionKey.set(normalized, item);
    }
    return bySessionKey;
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
        const err = new Error(`OpenClaw request failed: ${res.status}`);
        err.status = res.status;
        err.payload = data;
        throw err;
      }

      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  async #callGateway(method, params) {
    if (this.gatewayCallImpl) {
      return this.gatewayCallImpl(method, params);
    }
    return this.#gatewayRpcCall(method, params);
  }

  #shouldUseWs() {
    if (this.transport === 'ws') return true;
    if (this.transport === 'http') return false;
    if (this.fetchImpl !== globalThis.fetch) return false;
    // OpenClaw gateway (18789) uses WS RPC handshake for interactive send.
    return this.baseUrl.includes(':18789');
  }

  #toWsUrl(baseUrl) {
    const parsed = new URL(baseUrl);
    parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
    return parsed.toString();
  }

  #normalizeSessionKey(raw) {
    const text = String(raw || '').trim();
    if (!text) return '';
    const parts = text.split(':').filter(Boolean);
    return parts.at(-1) || text;
  }

  async #gatewayRpcCall(method, params) {
    const args = [
      'gateway',
      'call',
      method,
      '--url',
      this.wsUrl,
      '--params',
      JSON.stringify(params),
      '--timeout',
      String(this.timeoutMs),
      '--json',
    ];

    if (this.apiKey) {
      args.push('--token', this.apiKey);
    }

    try {
      const { stdout } = await execFileAsync('openclaw', args, { timeout: this.timeoutMs + 3000 });
      return stdout?.trim() ? JSON.parse(stdout) : {};
    } catch (error) {
      const stderr = error.stderr?.toString?.() || '';
      const stdout = error.stdout?.toString?.() || '';
      const message = stderr || stdout || error.message || `Gateway RPC call failed: ${method}`;
      throw new Error(message.trim());
    }
  }
}
