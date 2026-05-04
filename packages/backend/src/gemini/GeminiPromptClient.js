import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFileSync as _rf, writeFileSync as _wf, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const DEFAULT_STORE = process.env.OPENCLAW_GEMINI_SESSION_STORE || '.workspaces/.gemini-sessions.json';

export class GeminiPromptClient {
  constructor({
    command = process.env.OPENCLAW_GEMINI_CMD || 'gemini',
    cwd = process.cwd(),
    env = {
      ...process.env,
      IS_SANDBOX: process.env.IS_SANDBOX || '1',
    },
    storePath = DEFAULT_STORE,
    timeoutMs = Number(process.env.OPENCLAW_GEMINI_TIMEOUT_MS || 180000),
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
      id: `gemini:${sessionKey}`,
      cliType: 'gemini',
      status: 'idle',
      sessionKey,
      sessionId,
      transport: 'json',
      cwd: this.cwd,
    }));
  }

  getSession(id) {
    const sessionKey = id.startsWith('gemini:') ? id.slice('gemini:'.length) : id;
    const sessionId = this.sessionByKey.get(sessionKey);
    if (!sessionId) return null;
    return {
      id: `gemini:${sessionKey}`,
      cliType: 'gemini',
      status: 'idle',
      sessionKey,
      sessionId,
      transport: 'json',
      cwd: this.cwd,
    };
  }

  forgetSession(id) {
    const sessionKey = id.startsWith('gemini:') ? id.slice('gemini:'.length) : id;
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
    const extraArgs = (process.env.OPENCLAW_GEMINI_JSON_ARGS || '')
      .split(' ')
      .map((x) => x.trim())
      .filter(Boolean);
    const baseArgs = [
      '--prompt',
      prompt || '',
      '--output-format',
      'stream-json',
      '--yolo',
    ];

    const selectedModel = String(model || '').trim();
    if (selectedModel) {
      baseArgs.push('--model', selectedModel);
    }

    if (resume) {
      baseArgs.push('--resume', sessionId);
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
        reject(new Error(`Gemini JSON call timed out after ${this.timeoutMs}ms. Tail: ${detail}`));
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
      throw new Error((stderr || stdout || `Gemini exited with code ${exitCode}`).trim());
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
        if (event?.type === 'init' && typeof event?.session_id === 'string' && event.session_id.trim()) {
          return event.session_id.trim();
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

        // Handle {"type":"text","text":"chunk"} events
        if (event?.type === 'text' && typeof event.text === 'string' && event.text.trim()) {
          chunks.push(event.text.trim());
        }

        // Handle {"type":"message","role":"assistant","content":"..."} events
        if (event?.type === 'message' && event?.role === 'assistant' && typeof event?.content === 'string' && event.content.trim()) {
          chunks.push(event.content.trim());
        }
      } catch {
        // Ignore non-JSON lines in stream-json mode.
      }
    }
    return chunks.join('\n').trim();
  }
}
