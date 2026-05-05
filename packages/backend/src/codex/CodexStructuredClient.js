import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import { readFileSync as _rf, writeFileSync as _wf, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';

function defaultStorePath() {
  if (process.env.OPENCLAW_CODEX_SESSION_STORE) return process.env.OPENCLAW_CODEX_SESSION_STORE;
  return resolve(process.env.AUTOCLI_WORKSPACE_ROOT || resolve(homedir(), '.autocli'), '.codex-sessions.json');
}

const DEFAULT_LISTEN_URL = process.env.OPENCLAW_CODEX_APP_SERVER_URL || 'ws://127.0.0.1:8788';
const DEFAULT_TIMEOUT_MS = Number(process.env.OPENCLAW_CODEX_APP_SERVER_TIMEOUT_MS || 30000);

export class CodexStructuredClient extends EventEmitter {
  constructor({
    command = process.env.OPENCLAW_CODEX_CMD || 'codex',
    listenUrl = DEFAULT_LISTEN_URL,
    cwd = process.cwd(),
    env = process.env,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    autostart = process.env.OPENCLAW_CODEX_APP_SERVER_AUTOSTART !== '0',
    logger = console,
    storePath = defaultStorePath(),
  } = {}) {
    super();
    this.command = command;
    this.listenUrl = listenUrl;
    this.cwd = cwd;
    this.env = env;
    this.timeoutMs = timeoutMs;
    this.autostart = autostart;
    this.logger = logger;
    this.process = null;
    this.ws = null;
    this.pending = new Map();
    this.requestId = 1;
    this.storePath = storePath;
    this.threadBySessionKey = this.#loadStore();
    this.sessionInfoByThreadId = new Map(
      [...this.threadBySessionKey.values()].map((info) => [info.threadId, info])
    );
    this.connecting = null;
    this.initialized = false;
    this.serverFailed = false;
  }

  reset(reason = 'manual-reset') {
    this.logger?.warn?.(`Codex structured client reset: ${reason}`);
    this.#resetTransport(new Error(reason));
  }

  /** Probe whether the codex app-server is reachable.
   *  First tries a lightweight WebSocket handshake (no JSON-RPC initialize)
   *  to avoid the cost of the full connection handshake when we only need
   *  a yes/no answer.  Falls back to the full #ensureConnected path if
   *  autostart is enabled and no server process is running yet. */
  async isAvailable() {
    if (this.ws?.readyState === WebSocket.OPEN && this.initialized) return true;
    if (this.serverFailed) return false;

    /* 1. Quick probe: try connecting to the listen URL without going
       through the full ensureConnected flow (no spawn, no initialize).
       If a server is already listening, this succeeds in <200ms. */
    try {
      await new Promise((resolve, reject) => {
        const socket = new WebSocket(this.listenUrl);
        const timer = setTimeout(() => { socket.terminate(); reject(new Error('probe timeout')); }, 2000);
        socket.once('open', () => { clearTimeout(timer); socket.close(); resolve(); });
        socket.once('error', () => { clearTimeout(timer); reject(new Error('probe failed')); });
      });
      return true; // server is listening
    } catch {
      /* Server not listening yet — fall through */
    }

    /* 2. If autostart is enabled, try the full connection path (which may
       spawn the app-server).  If autostart is disabled and the quick probe
       failed, the server is definitively not available. */
    if (!this.autostart) return false;

    try {
      await this.#ensureConnected();
      return this.initialized;
    } catch {
      return false;
    }
  }

  async submitPrompt({ sessionKey, prompt, cwd = this.cwd, model = '' }) {
    await this.#ensureConnected();
    const existing = this.threadBySessionKey.get(sessionKey) || null;
    const thread = existing
      ? await this.#resumeThread(existing.threadId, cwd)
      : await this.#startThread(cwd);

    const turn = await this.#startTurn(thread.id, prompt, model);
    const nextInfo = {
      sessionKey,
      threadId: thread.id,
      activeTurnId: turn.id,
      cwd,
    };
    this.threadBySessionKey.set(sessionKey, nextInfo);
    this.sessionInfoByThreadId.set(thread.id, nextInfo);
    this.#saveStore();

    return {
      threadId: thread.id,
      turnId: turn.id,
      sessionKey,
    };
  }

  async sendInput({ sessionKey, threadId, message, model = '' }) {
    await this.#ensureConnected();
    const info = threadId
      ? this.sessionInfoByThreadId.get(threadId)
      : this.threadBySessionKey.get(sessionKey);
    if (!info?.threadId) {
      throw new Error(`Unknown codex structured session: ${sessionKey || threadId}`);
    }

    let turnId = info.activeTurnId;
    if (!turnId) {
      const turn = await this.#startTurn(info.threadId, message, model);
      info.activeTurnId = turn.id;
      this.threadBySessionKey.set(info.sessionKey, info);
      this.sessionInfoByThreadId.set(info.threadId, info);
      return { threadId: info.threadId, turnId: turn.id, sessionKey: info.sessionKey };
    }

    let nextTurnId = null;
    try {
      const response = await this.#request('turn/steer', {
        threadId: info.threadId,
        expectedTurnId: turnId,
        input: [this.#textInput(message)],
      });
      nextTurnId = response.turnId;
    } catch (error) {
      const messageText = String(error?.message || '');
      if (!/no active turn to steer/i.test(messageText)) {
        throw error;
      }
      const turn = await this.#startTurn(info.threadId, message, model);
      nextTurnId = turn.id;
    }
    info.activeTurnId = nextTurnId;
    this.threadBySessionKey.set(info.sessionKey, info);
    this.sessionInfoByThreadId.set(info.threadId, info);
    return { threadId: info.threadId, turnId: nextTurnId, sessionKey: info.sessionKey };
  }

  listSessions() {
    return [...this.threadBySessionKey.values()].map((info) => ({
      id: `codex:${info.sessionKey}`,
      cliType: 'codex',
      status: info.activeTurnId ? 'running' : 'idle',
      threadId: info.threadId,
      sessionKey: info.sessionKey,
      cwd: info.cwd,
      transport: 'structured',
    }));
  }

  getSession(id) {
    const sessionKey = id.startsWith('codex:') ? id.slice('codex:'.length) : id;
    const info = this.threadBySessionKey.get(sessionKey);
    if (!info) return null;
    return {
      id: `codex:${info.sessionKey}`,
      cliType: 'codex',
      status: info.activeTurnId ? 'running' : 'idle',
      threadId: info.threadId,
      sessionKey: info.sessionKey,
      cwd: info.cwd,
      transport: 'structured',
    };
  }

  forgetSession(id) {
    const sessionKey = id.startsWith('codex:') ? id.slice('codex:'.length) : id;
    const info = this.threadBySessionKey.get(sessionKey);
    if (!info) return false;
    this.threadBySessionKey.delete(sessionKey);
    this.sessionInfoByThreadId.delete(info.threadId);
    this.#saveStore();
    return true;
  }

  #loadStore() {
    try { return new Map(Object.entries(JSON.parse(_rf(this.storePath, 'utf8')))); }
    catch { return new Map(); }
  }

  #saveStore() {
    try {
      mkdirSync(dirname(this.storePath), { recursive: true });
      _wf(this.storePath, JSON.stringify(Object.fromEntries(this.threadBySessionKey)), 'utf8');
    } catch { /* best-effort */ }
  }

  async #ensureConnected() {
    if (this.ws?.readyState === WebSocket.OPEN && this.initialized) {
      return;
    }
    if (this.connecting) {
      return this.connecting;
    }
    if (this.serverFailed) {
      throw new Error(`Codex CLI ('${this.command}') is not available. Install it or use runtime 'openclaw' instead.`);
    }

    this.connecting = (async () => {
      if (this.autostart && !this.process) {
        this.serverFailed = false;
        this.#startServer();
        // Give the spawn a brief moment to fail (ENOENT is async)
        await new Promise((r) => setTimeout(r, 200));
        if (this.serverFailed) {
          throw new Error(`Codex CLI ('${this.command}') is not available. Install it or use runtime 'openclaw' instead.`);
        }
      }
      this.ws = await this.#connectWs();
      this.ws.on('message', (raw) => this.#onMessage(raw));
      this.ws.on('close', () => {
        this.ws = null;
        this.initialized = false;
      });
      await this.#request('initialize', {
        clientInfo: {
          name: 'openclaw-cli-auto',
          version: '0.1.0',
        },
        capabilities: {
          experimentalApi: true,
        },
      });
      this.initialized = true;
    })();

    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  #startServer() {
    const extraArgs = (process.env.OPENCLAW_CODEX_APP_SERVER_ARGS || '')
      .split(' ')
      .map((x) => x.trim())
      .filter(Boolean);
    try {
      this.process = spawn(this.command, ['app-server', '--listen', this.listenUrl, ...extraArgs], {
        cwd: this.cwd,
        env: this.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      this.logger?.warn?.(`Failed to spawn codex: ${err.message}`);
      this.process = null;
      return;
    }
    this.process.on('error', (err) => {
      this.logger?.warn?.(`Codex process error: ${err.message}`);
      this.process = null;
      this.serverFailed = true;
    });
    this.process.stdout.on('data', (data) => {
      this.emit('server:log', { stream: 'stdout', data: data.toString() });
    });
    this.process.stderr.on('data', (data) => {
      this.emit('server:log', { stream: 'stderr', data: data.toString() });
    });
    this.process.on('exit', () => {
      this.process = null;
    });
  }

  async #connectWs() {
    const start = Date.now();
    const maxWait = Math.min(this.timeoutMs, 5000); // cap initial connect at 5s
    while (Date.now() - start < maxWait) {
      if (this.serverFailed) {
        throw new Error(`Codex CLI ('${this.command}') is not available. Install it or use runtime 'openclaw' instead.`);
      }
      try {
        const ws = await new Promise((resolve, reject) => {
          const socket = new WebSocket(this.listenUrl);
          socket.once('open', () => resolve(socket));
          socket.once('error', reject);
        });
        return ws;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    throw new Error(
      `Timed out connecting to codex app-server at ${this.listenUrl}. ` +
      `Ensure '${this.command}' is installed and the app-server starts successfully.`
    );
  }

  async #startThread(cwd) {
    const response = await this.#request('thread/start', {
      cwd,
      sandbox: 'danger-full-access',
      approvalPolicy: 'never',
      personality: 'pragmatic',
    });
    return response.thread;
  }

  async #resumeThread(threadId, cwd) {
    const response = await this.#request('thread/resume', {
      threadId,
      cwd,
      sandbox: 'danger-full-access',
      approvalPolicy: 'never',
      personality: 'pragmatic',
    });
    return response.thread;
  }

  async #startTurn(threadId, prompt, model = '') {
    const payload = {
      threadId,
      input: [this.#textInput(prompt)],
      approvalPolicy: 'never',
    };
    const selectedModel = String(model || '').trim();
    if (selectedModel) {
      payload.model = selectedModel;
    }
    const response = await this.#request('turn/start', payload);
    return response.turn;
  }

  #textInput(text) {
    return {
      type: 'text',
      text,
      text_elements: [],
    };
  }

  async #request(method, params) {
    const id = this.requestId++;
    const payload = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };
    const response = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`Codex structured request timed out: ${method}`);
        this.#resetTransport(error);
        reject(error);
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.ws.send(JSON.stringify(payload));
    });
    return response;
  }

  #resetTransport(error = new Error('Codex structured transport reset')) {
    this.connected = false;
    this.initialized = false;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.removeAllListeners();
        ws.terminate?.();
      } catch {}
    }
    for (const [id, pending] of this.pending.entries()) {
      this.pending.delete(id);
      pending.reject(error);
    }
    const child = this.process;
    this.process = null;
    if (child) {
      try {
        child.kill('SIGTERM');
      } catch {}
    }
  }

  #onMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (typeof message.id !== 'undefined') {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    const method = String(message.method || '');
    const params = message.params || {};
    this.emit('notification', { method, params });
    const deltaText = this.#extractText(
      params.delta
      ?? params.textDelta
      ?? params.text_delta
      ?? params?.item?.delta
      ?? params?.item?.text
      ?? params?.item?.content
      ?? '',
    );
    const deltaThreadId = params.threadId || params.thread_id || params?.item?.threadId || params?.item?.thread_id;
    const deltaTurnId = params.turnId || params.turn_id || params?.item?.turnId || params?.item?.turn_id;
    if (
      method === 'item/agentMessage/delta' ||
      method === 'item/agent_message/delta' ||
      method === 'item/assistant_message/delta' ||
      method.includes('AgentMessageDelta') ||
      method.includes('agentMessageDelta') ||
      method.includes('assistantMessageDelta') ||
      (deltaText && deltaThreadId)
    ) {
      this.emit('delta', {
        threadId: deltaThreadId,
        turnId: deltaTurnId || null,
        delta: deltaText,
      });
      return;
    }

    if (
      method === 'turn/completed' ||
      method === 'turn/completed/v2' ||
      method === 'turn/complete' ||
      method.includes('TurnCompleted') ||
      method.includes('turnCompleted') ||
      (params.threadId && params.turn?.id && params.turn?.status === 'completed') ||
      (params.thread_id && params.turn?.id && params.turn?.status === 'completed')
    ) {
      const completedThreadId = params.threadId || params.thread_id;
      const info = this.sessionInfoByThreadId.get(completedThreadId);
      if (info) {
        info.activeTurnId = null;
        this.threadBySessionKey.set(info.sessionKey, info);
        this.sessionInfoByThreadId.set(info.threadId, info);
      }
      this.emit('turn:completed', {
        threadId: completedThreadId,
        turn: params.turn || null,
      });
      return;
    }

    if ((method === 'turn/started' || method.includes('TurnStarted') || method.includes('turnStarted')) && params.threadId && params.turn?.id) {
      const info = this.sessionInfoByThreadId.get(params.threadId);
      if (info) {
        info.activeTurnId = params.turn.id;
        this.threadBySessionKey.set(info.sessionKey, info);
        this.sessionInfoByThreadId.set(info.threadId, info);
      }
    }
  }

  #extractText(input) {
    if (typeof input === 'string') return input;
    if (typeof input === 'number' || typeof input === 'boolean') return String(input);
    if (Array.isArray(input)) {
      return input.map((item) => this.#extractText(item)).join('');
    }
    if (!input || typeof input !== 'object') return '';
    if (typeof input.text === 'string') return input.text;
    if (typeof input.content === 'string') return input.content;
    if (Array.isArray(input.content)) return this.#extractText(input.content);
    if (typeof input.delta === 'string') return input.delta;
    if (typeof input.value === 'string') return input.value;
    return '';
  }
}
