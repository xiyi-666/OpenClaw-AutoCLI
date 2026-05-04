import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFileSync as _rf, writeFileSync as _wf, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const DEFAULT_STORE = process.env.OPENCLAW_CLAUDE_SESSION_STORE || '.workspaces/.claude-sessions.json';

export class ClaudeJsonClient {
  constructor({
    command = process.env.OPENCLAW_CLAUDE_CMD || 'claude',
    cwd = process.cwd(),
    env = {
      ...process.env,
      IS_SANDBOX: process.env.IS_SANDBOX || '1',
    },
    timeoutMs = Number(process.env.OPENCLAW_CLAUDE_TIMEOUT_MS || 120000),
    storePath = DEFAULT_STORE,
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
      id: `claude:${sessionKey}`,
      cliType: 'claude',
      status: 'idle',
      sessionKey,
      sessionId,
      transport: 'json',
      cwd: this.cwd,
    }));
  }

  getSession(id) {
    const sessionKey = id.startsWith('claude:') ? id.slice('claude:'.length) : id;
    const sessionId = this.sessionByKey.get(sessionKey);
    if (!sessionId) return null;
    return {
      id: `claude:${sessionKey}`,
      cliType: 'claude',
      status: 'idle',
      sessionKey,
      sessionId,
      transport: 'json',
      cwd: this.cwd,
    };
  }

  forgetSession(id) {
    const sessionKey = id.startsWith('claude:') ? id.slice('claude:'.length) : id;
    return this.sessionByKey.delete(sessionKey);
  }

  async submitPrompt({ sessionKey, prompt }) {
    const key = sessionKey || randomUUID();
    const existingSessionId = this.sessionByKey.get(key);
    const sessionId = existingSessionId || randomUUID();
    const resume = Boolean(existingSessionId);
    this.sessionByKey.set(key, sessionId);
    this.#saveStore();
    const args = this.#buildArgs({ sessionId, prompt, resume });
    const output = await this.#run(args);
    return {
      sessionKey: key,
      sessionId,
      text: output.text,
      raw: output.raw,
    };
  }

  async sendInput({ sessionKey, message }) {
    return this.submitPrompt({ sessionKey, prompt: message });
  }

  #loadStore() {
    try {
      return new Map(Object.entries(JSON.parse(_rf(this.storePath, 'utf8'))));
    } catch { return new Map(); }
  }

  #saveStore() {
    try {
      mkdirSync(dirname(this.storePath), { recursive: true });
      _wf(this.storePath, JSON.stringify(Object.fromEntries(this.sessionByKey)), 'utf8');
    } catch { /* best-effort */ }
  }

  #buildArgs({ sessionId, prompt, resume }) {
    const extraArgs = (process.env.OPENCLAW_CLAUDE_JSON_ARGS || '')
      .split(' ')
      .map((x) => x.trim())
      .filter(Boolean);
    const baseArgs = [
      '--print',
      '--verbose',
      '--output-format',
      'stream-json',
    ];
    const canUseDangerousSkipPermissions = !(
      typeof process.getuid === 'function' && process.getuid() === 0
    );
    if (canUseDangerousSkipPermissions) {
      baseArgs.push('--dangerously-skip-permissions');
    }

    if (resume) {
      baseArgs.push('--resume', sessionId);
    } else {
      baseArgs.push('--session-id', sessionId);
    }
    return [...baseArgs, ...extraArgs, prompt || ''];
  }

  async #run(args) {
    const child = spawn(this.command, args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    const promptArg = String(args[args.length - 1] || '');
    if (child.stdin) {
      try {
        if (promptArg.trim()) {
          child.stdin.write(`${promptArg}\n`);
        }
      } catch {
        // Best-effort stdin fallback for --print mode.
      } finally {
        child.stdin.end();
      }
    }

    const exitCode = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`Claude JSON call timed out after ${this.timeoutMs}ms`));
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
    if (exitCode !== 0 && !text) {
      throw new Error((stderr || stdout || `Claude exited with code ${exitCode}`).trim());
    }
    return {
      text: text || stderr.trim() || stdout.trim(),
      raw: stdout.trim() || stderr.trim(),
    };
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
        const msg = event?.message;
        const content = msg?.content;
        if (Array.isArray(content)) {
          for (const part of content) {
            if (typeof part?.text === 'string' && part.text.trim()) {
              chunks.push(part.text.trim());
            }
          }
        }
        if (typeof event?.text === 'string' && event.text.trim()) {
          chunks.push(event.text.trim());
        }
      } catch {
        // Ignore non-JSON lines in stream-json mode.
      }
    }
    return chunks.join('\n').trim();
  }
}
