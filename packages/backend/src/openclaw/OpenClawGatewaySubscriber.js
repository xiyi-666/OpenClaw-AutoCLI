import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';

import WebSocket from 'ws';

const DEFAULT_RECONNECT_MS = Number(process.env.OPENCLAW_GATEWAY_RECONNECT_MS || 2000);
const DEFAULT_CONNECT_TIMEOUT_MS = Number(process.env.OPENCLAW_GATEWAY_CONNECT_TIMEOUT_MS || 10000);

export class OpenClawGatewaySubscriber extends EventEmitter {
  constructor({
    wsUrl = process.env.OPENCLAW_WS_URL || 'ws://127.0.0.1:18789',
    devicePath = process.env.OPENCLAW_DEVICE_IDENTITY_PATH || '/root/.openclaw/identity/device.json',
    deviceAuthPath = process.env.OPENCLAW_DEVICE_AUTH_PATH || '/root/.openclaw/identity/device-auth.json',
    reconnectMs = DEFAULT_RECONNECT_MS,
    connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
    logger = console,
  } = {}) {
    super();
    this.wsUrl = wsUrl;
    this.devicePath = devicePath;
    this.deviceAuthPath = deviceAuthPath;
    this.reconnectMs = reconnectMs;
    this.connectTimeoutMs = connectTimeoutMs;
    this.logger = logger;
    this.ws = null;
    this.connected = false;
    this.connecting = null;
    this.requestId = 1;
    this.pending = new Map();
    this.subscriptions = new Set();
    this.reconnectTimer = null;
    this.closed = false;
  }

  async connect() {
    if (this.closed) return;
    if (this.connected) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.#connectInternal();
    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  close() {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const pending of this.pending.values()) {
      pending.reject(new Error('Gateway subscriber closed'));
      clearTimeout(pending.timer);
    }
    this.pending.clear();
    this.ws?.close();
    this.ws = null;
    this.connected = false;
  }

  async subscribeSession(sessionKey) {
    const normalized = this.#normalizeSessionKey(sessionKey);
    if (!normalized) return;
    this.subscriptions.add(normalized);
    await this.connect();
    if (!this.connected) return;
    await this.#request('sessions.messages.subscribe', { key: normalized });
  }

  async #connectInternal() {
    const identity = this.#loadIdentity();
    const socket = await new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error(`Timed out connecting to OpenClaw gateway: ${this.wsUrl}`));
      }, this.connectTimeoutMs);
      ws.once('open', () => {
        clearTimeout(timer);
        resolve(ws);
      });
      ws.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    this.ws = socket;
    socket.on('message', (raw) => this.#onMessage(raw, identity));
    socket.on('close', () => this.#onClose());
    socket.on('error', (error) => {
      this.emit('error', error);
    });
  }

  async #request(method, params) {
    const id = String(this.requestId++);
    const payload = {
      type: 'req',
      id,
      method,
      params,
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Gateway request timed out: ${method}`));
      }, this.connectTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws?.send(JSON.stringify(payload));
    });
  }

  async #onMessage(raw, identity) {
    let message = null;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (message.type === 'event' && message.event === 'connect.challenge') {
      const params = this.#buildConnectParams(message.payload, identity);
      this.ws?.send(JSON.stringify({
        type: 'req',
        id: 'connect',
        method: 'connect',
        params,
      }));
      return;
    }
    if (message.type === 'res') {
      if (message.id === 'connect') {
        if (!message.ok) {
          const error = new Error(message.error?.message || 'Gateway connect failed');
          this.emit('error', error);
          this.ws?.close();
          return;
        }
        this.connected = true;
        for (const key of this.subscriptions) {
          this.#request('sessions.messages.subscribe', { key }).catch((error) => {
            this.logger?.warn?.(`Gateway session subscribe failed for ${key}: ${error.message}`);
          });
        }
        this.emit('connected', message.payload);
        return;
      }
      const pending = this.pending.get(String(message.id));
      if (!pending) return;
      this.pending.delete(String(message.id));
      clearTimeout(pending.timer);
      if (message.ok) pending.resolve(message.payload);
      else pending.reject(new Error(message.error?.message || `Gateway request failed: ${message.id}`));
      return;
    }
    if (message.type === 'event' && message.event === 'session.message') {
      const payload = message.payload || {};
      this.emit('session:message', payload);
    }
  }

  #onClose() {
    this.connected = false;
    this.ws = null;
    for (const pending of this.pending.values()) {
      pending.reject(new Error('Gateway socket closed'));
      clearTimeout(pending.timer);
    }
    this.pending.clear();
    if (this.closed) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch((error) => {
        this.logger?.warn?.(`Gateway reconnect failed: ${error.message}`);
      });
    }, this.reconnectMs);
    if (typeof this.reconnectTimer.unref === 'function') {
      this.reconnectTimer.unref();
    }
  }

  #loadIdentity() {
    const device = JSON.parse(fs.readFileSync(this.devicePath, 'utf8'));
    const deviceAuth = JSON.parse(fs.readFileSync(this.deviceAuthPath, 'utf8'));
    if (!device?.privateKeyPem || !device?.publicKeyPem || !device?.deviceId) {
      throw new Error('OpenClaw device identity is incomplete');
    }
    if (!deviceAuth?.tokens?.operator?.token) {
      throw new Error('OpenClaw device auth token is missing');
    }
    return {
      device,
      deviceAuth,
    };
  }

  #buildConnectParams(challenge, identity) {
    const { device, deviceAuth } = identity;
    const token = deviceAuth.tokens.operator.token;
    const scopes = Array.isArray(deviceAuth.tokens.operator.scopes) ? deviceAuth.tokens.operator.scopes : ['operator.read', 'operator.write'];
    const platform = 'linux';
    const deviceFamily = 'linux';
    const privateKey = createPrivateKey(device.privateKeyPem);
    const publicKey = createPublicKey(device.publicKeyPem);
    const publicKeyRaw = publicKey
      .export({ type: 'spki', format: 'der' })
      .subarray(-32)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');
    const payload = [
      'v3',
      device.deviceId,
      'cli',
      'cli',
      'operator',
      scopes.join(','),
      String(challenge.ts),
      token,
      challenge.nonce,
      platform,
      deviceFamily,
    ].join('|');
    const signature = sign(null, Buffer.from(payload), privateKey)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');
    return {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: 'cli',
        version: '2026.3.28',
        platform,
        mode: 'cli',
        deviceFamily: 'Linux',
      },
      role: 'operator',
      scopes,
      caps: [],
      commands: [],
      permissions: {},
      auth: { token },
      locale: 'en-US',
      userAgent: 'openclaw-cli-auto/0.1.0',
      device: {
        id: device.deviceId,
        publicKey: publicKeyRaw,
        signature,
        signedAt: challenge.ts,
        nonce: challenge.nonce,
      },
    };
  }

  #normalizeSessionKey(raw) {
    const text = String(raw || '').trim();
    if (!text) return '';
    return text.startsWith('agent:') ? text : `agent:main:${text}`;
  }
}
