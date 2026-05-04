import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const DEFAULT_ROWS = 50;
const DEFAULT_COLS = 220;
const require = createRequire(import.meta.url);

let nodePty = null;
try {
  nodePty = require('node-pty');
} catch {
  nodePty = null;
}

const ptyAvailable = !!nodePty;

export class Session extends EventEmitter {
  constructor(id, cliType, { command, args = [], cwd = process.cwd(), env = process.env, logger = console, usePty, closeStdinOnStart = false } = {}) {
    super();
    this.id = id;
    this.cliType = cliType;
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.env = env;
    this.logger = logger;
    this.usePty = usePty;
    this.closeStdinOnStart = closeStdinOnStart;
    this.tokenCount = 0;
    this.checkpoint = '';
    this.status = 'running';
    this.process = this.spawn();
  }

  spawn() {
    const preferPty =
      (this.usePty ?? true) &&
      nodePty &&
      (process.env.OPENCLAW_USE_PTY === '1' ||
        ['codex', 'claude', 'gemini', 'opencode'].includes(String(this.cliType || '').toLowerCase()));

    const wantsPty = (this.usePty ?? true) &&
      ['codex', 'claude', 'gemini', 'opencode'].includes(String(this.cliType || '').toLowerCase());

    if (wantsPty && !preferPty) {
      this.logger.warn?.(
        `[Session] PTY mode requested for ${this.cliType} but node-pty is ${ptyAvailable ? 'available' : 'not available'}; ` +
        `OPENCLAW_USE_PTY=${process.env.OPENCLAW_USE_PTY || '(unset)'}. ` +
        `Interactive CLIs may not work correctly in pipe mode.`,
      );
    }

    if (preferPty) {
      const pty = nodePty.spawn(this.command, this.args, {
        name: 'xterm-color',
        cols: Number(process.env.OPENCLAW_PTY_COLS || DEFAULT_COLS),
        rows: Number(process.env.OPENCLAW_PTY_ROWS || DEFAULT_ROWS),
        cwd: this.cwd,
        env: this.env,
      });

      pty.onData((data) => this.emit('output', data.toString()));
      pty.onExit(() => {
        this.status = 'done';
        this.emit('exit');
      });

      return {
        isPty: true,
        stdin: { writable: true },
        write: (text) => pty.write(text),
        kill: () => pty.kill(),
      };
    }

    const child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    child.on('error', (err) => {
      this.status = 'done';
      this.emit('output', `Error: ${err.message}\n`);
      this.emit('exit');
    });

    child.stdout.on('data', (data) => {
      const text = data.toString();
      this.emit('output', text);
    });
    child.stderr.on('data', (data) => {
      const text = data.toString();
      this.emit('output', text);
    });
    child.on('exit', () => {
      this.status = 'done';
      this.emit('exit');
    });

    if (this.closeStdinOnStart && child.stdin?.writable) {
      child.stdin.end();
    }

    return child;
  }

  send(message) {
    if (!this.process) return;
    if (this.process.isPty) {
      this.process.write(`${message}\r`);
      return;
    }
    if (!this.process?.stdin?.writable) return;
    this.process.stdin.write(`${message}\n`);
  }

  kill() {
    this.process?.kill();
    this.status = 'done';
  }
}

export class SessionManager extends EventEmitter {
  constructor({ sessionFactory, logger = console } = {}) {
    super();
    this.sessionFactory = sessionFactory;
    this.logger = logger;
    this.sessions = new Map();
  }

  createSession(id, cliType, options = {}) {
    const session = this.sessionFactory
      ? this.sessionFactory(id, cliType, options)
      : new Session(id, cliType, options);

    this.sessions.set(id, session);
    session.on('output', (data) => this.emit('session:output', id, data));
    session.on('exit', () => this.emit('session:exit', id));
    this.emit('session:created', session);
    return session;
  }

  get(id) {
    return this.sessions.get(id) || null;
  }

  list() {
    return [...this.sessions.values()].map((session) => ({
      id: session.id,
      cliType: session.cliType,
      status: session.status,
      command: session.command,
      args: session.args,
      cwd: session.cwd,
    }));
  }

  send(id, message) {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Unknown session: ${id}`);
    session.send(message);
  }

  kill(id) {
    const session = this.sessions.get(id);
    if (!session) return;
    session.kill();
  }

  remove(id, { kill = true } = {}) {
    const session = this.sessions.get(id);
    if (!session) return;
    if (kill) {
      session.kill();
    }
    this.sessions.delete(id);
  }

  pause(id) {
    const session = this.sessions.get(id);
    if (!session) return;
    session.status = 'paused';
    this.emit('session:paused', id);
  }

  onAny(listener) {
    this.on('session:created', (session) => listener('session:created', session.id, session));
    this.on('session:output', (id, data) => listener('session:output', id, data));
    this.on('session:exit', (id) => listener('session:exit', id, null));
    this.on('session:paused', (id) => listener('session:paused', id, null));
  }
}
