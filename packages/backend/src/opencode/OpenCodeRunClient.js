import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFileSync as _rf, writeFileSync as _wf, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { resolve } from 'node:path';
import { homedir } from 'node:os';

function defaultStorePath() {
  if (process.env.OPENCLAW_OPENCODE_SESSION_STORE) return process.env.OPENCLAW_OPENCODE_SESSION_STORE;
  return resolve(process.env.AUTOCLI_WORKSPACE_ROOT || resolve(homedir(), '.autocli'), '.opencode-sessions.json');
}

export class OpenCodeRunClient {
  constructor({
    command = process.env.OPENCLAW_OPENCODE_CMD || 'opencode',
    cwd = process.cwd(),
    env = {
      ...process.env,
      IS_SANDBOX: process.env.IS_SANDBOX || '1',
    },
    storePath = defaultStorePath(),
    timeoutMs = Number(process.env.OPENCLAW_OPENCODE_TIMEOUT_MS || 180000),
  } = {}) {
    this.command = command;
    this.cwd = cwd;
    this.env = env;
    this.timeoutMs = timeoutMs;
    this.storePath = storePath;
    this.sessionByKey = this.#loadStore();
  }

  listSessions() {
    return [...this.sessionByKey.entries()].map(([sessionKey, sessionId]) => ({
      id: `opencode:${sessionKey}`,
      cliType: 'opencode',
      status: 'idle',
      sessionKey,
      sessionId,
      transport: 'json',
      cwd: this.cwd,
    }));
  }

  getSession(id) {
    const sessionKey = id.startsWith('opencode:') ? id.slice('opencode:'.length) : id;
    const sessionId = this.sessionByKey.get(sessionKey);
    if (!sessionId) return null;
    return {
      id: `opencode:${sessionKey}`,
      cliType: 'opencode',
      status: 'idle',
      sessionKey,
      sessionId,
      transport: 'json',
      cwd: this.cwd,
    };
  }

  forgetSession(id) {
    const sessionKey = id.startsWith('opencode:') ? id.slice('opencode:'.length) : id;
    return this.sessionByKey.delete(sessionKey);
  }

  async submitPrompt({ sessionKey, prompt, model = '' }) {
    const key = sessionKey || randomUUID();
    const existingSessionId = this.sessionByKey.get(key);
    const resume = Boolean(existingSessionId);
    const args = this.#buildArgs({ sessionId: existingSessionId, prompt, resume, model });
    const output = await this.#run(args);
    const nextSessionId = output.sessionId || existingSessionId || randomUUID();
    this.sessionByKey.set(key, nextSessionId);
    return {
      sessionKey: key,
      sessionId: nextSessionId,
      text: output.text,
      raw: output.raw,
    };
  }

  async sendInput({ sessionKey, message, model = '' }) {
    return this.submitPrompt({ sessionKey, prompt: message, model });
  }

  #loadStore() {
    try { return new Map(Object.entries(JSON.parse(_rf(this.storePath, 'utf8')))); }
    catch { return new Map(); }
  }

  #saveStore() {
    try {
      mkdirSync(dirname(this.storePath), { recursive: true });
      _wf(this.storePath, JSON.stringify(Object.fromEntries(this.sessionByKey)), 'utf8');
    } catch { /* best-effort */ }
  }

  #buildArgs({ sessionId, prompt, resume, model = '' }) {
    const extraArgs = (process.env.OPENCLAW_OPENCODE_JSON_ARGS || '')
      .split(' ')
      .map((x) => x.trim())
      .filter(Boolean);
    const baseArgs = [
      'run',
      '--format', 'json',
    ];

    const selectedModel = String(model || '').trim();
    if (selectedModel) {
      baseArgs.push('--model', selectedModel);
    }

    if (resume && sessionId) {
      baseArgs.push('--session', sessionId);
    }

    if (prompt) {
      baseArgs.push(prompt);
    }

    return [...baseArgs, ...extraArgs];
  }

  async #run(args) {
    const child = spawn(this.command, args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    const exitCode = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        const stderrTail = stderr.slice(-2000).trim();
        const stdoutTail = stdout.slice(-1200).trim();
        const detail = stderrTail || stdoutTail || 'no output captured';
        reject(new Error(`OpenCode run timed out after ${this.timeoutMs}ms. Tail: ${detail}`));
      }, this.timeoutMs);
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        resolve(code ?? 0);
      });
    });

    const text = this.#extractText(stdout);
    const sessionId = this.#extractSessionId(stdout);
    if (exitCode !== 0 && !text) {
      throw new Error((stderr || stdout || `OpenCode exited with code ${exitCode}`).trim());
    }
    return {
      text: text || stderr.trim() || stdout.trim(),
      raw: stdout.trim() || stderr.trim(),
      sessionId,
    };
  }

  #extractSessionId(stream) {
    const lines = stream
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        const candidates = [
          event?.sessionID,
          event?.sessionId,
          event?.session_id,
          event?.session?.id,
          event?.data?.sessionID,
          event?.data?.sessionId,
          event?.data?.session_id,
        ];
        for (const value of candidates) {
          if (typeof value === 'string' && value.trim()) return value.trim();
        }
      } catch {
        // Ignore non-JSON lines in stream-json mode.
      }
    }
    return '';
  }

  #extractText(stream) {
    const lines = stream
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    const chunks = [];
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        const eventType = String(event?.type || '').toLowerCase();
        const candidates = [
          event?.part?.text,
          event?.part?.content,
          event?.text,
          event?.message,
          event?.content,
          event?.delta,
          event?.output_text,
          event?.data?.text,
          event?.data?.message,
          event?.data?.content,
          event?.data?.delta,
        ];
        if (Array.isArray(event?.parts)) {
          for (const part of event.parts) {
            if (typeof part?.text === 'string') candidates.push(part.text);
            if (typeof part?.content === 'string') candidates.push(part.content);
          }
        }
        for (const candidate of candidates) {
          if (typeof candidate === 'string' && candidate.trim()) {
            if (eventType && ['step_start', 'step_end', 'session_start', 'session_end'].includes(eventType)) {
              continue;
            }
            chunks.push(candidate.trim());
          }
        }
      } catch {
        // Ignore non-JSON lines in stream-json mode.
      }
    }
    return chunks.join('\n').trim();
  }
}
