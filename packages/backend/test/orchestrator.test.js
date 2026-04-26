import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { TaskOrchestrator } from '../src/orchestrator/TaskOrchestrator.js';

class FakeClaudeClient {
  constructor() {
    this.sessions = new Map();
  }

  async submitPrompt({ sessionKey, prompt }) {
    const id = this.sessions.get(sessionKey) || `s-${sessionKey}`;
    this.sessions.set(sessionKey, id);
    return { sessionKey, sessionId: id, text: prompt || 'ok' };
  }

  async sendInput({ sessionKey, message }) {
    return this.submitPrompt({ sessionKey, prompt: message });
  }

  listSessions() {
    return [...this.sessions.entries()].map(([sessionKey, sessionId]) => ({
      id: `claude:${sessionKey}`,
      cliType: 'claude',
      status: 'idle',
      sessionKey,
      sessionId,
      transport: 'json',
    }));
  }

  getSession(id) {
    const sessionKey = id.startsWith('claude:') ? id.slice('claude:'.length) : id;
    const sessionId = this.sessions.get(sessionKey);
    if (!sessionId) return null;
    return {
      id: `claude:${sessionKey}`,
      cliType: 'claude',
      status: 'idle',
      sessionKey,
      sessionId,
      transport: 'json',
    };
  }

  forgetSession(id) {
    const sessionKey = id.startsWith('claude:') ? id.slice('claude:'.length) : id;
    return this.sessions.delete(sessionKey);
  }
}

test('submitTask delegates to openclaw client', async () => {
  let payload = null;
  const client = {
    submitConversation: async (input) => {
      payload = input;
      return { upstreamTaskId: 'upstream-1', status: 'accepted' };
    },
  };
  const orchestrator = new TaskOrchestrator({ client });
  orchestrator.addTask({ id: 'task-1', prompt: 'generate app', sessionType: 'openclaw' });

  const result = await orchestrator.submitTask('task-1');

  assert.equal(result.upstreamTaskId, 'upstream-1');
  assert.equal(payload.taskId, 'task-1');
  assert.equal(payload.prompt, 'generate app');
  assert.equal(orchestrator.tasks.get('task-1').status, 'submitted');
});

test('submitTask routes codex tasks to structured codex client by default', async () => {
  const codexClient = {
    submitPrompt: async ({ sessionKey, prompt }) => ({
      threadId: `thread-${sessionKey}`,
      turnId: 'turn-1',
      prompt,
    }),
    on: () => {},
  };
  const orchestrator = new TaskOrchestrator({ client: null, sessionManager: null, codexClient });
  orchestrator.addTask({ id: 'task-local-1', prompt: 'who are you', sessionType: 'codex' });

  const result = await orchestrator.submitTask('task-local-1');

  assert.equal(result.status, 'started');
  assert.equal(result.raw.transport, 'structured');
  assert.equal(result.raw.threadId, 'thread-task-local-1');
  assert.equal(result.raw.sessionId, 'codex:task-local-1');
  assert.equal(result.raw.sessionKey, 'task-local-1');
});

test('codex structured output keeps turn boundaries across follow-up input', async () => {
  const codexClient = new EventEmitter();
  codexClient.submitPrompt = async () => ({
    threadId: 'thread-codex-1',
    turnId: 'turn-codex-1',
  });
  codexClient.sendInput = async () => ({
    threadId: 'thread-codex-1',
    turnId: 'turn-codex-2',
  });
  const orchestrator = new TaskOrchestrator({ client: null, sessionManager: null, codexClient });
  orchestrator.addTask({ id: 'task-codex-turns', prompt: 'first', sessionType: 'codex' });

  await orchestrator.submitTask('task-codex-turns');
  codexClient.emit('delta', { threadId: 'thread-codex-1', turnId: 'turn-codex-1', delta: 'CLI=cod' });
  codexClient.emit('delta', { threadId: 'thread-codex-1', turnId: 'turn-codex-1', delta: 'CLI=codex' });
  codexClient.emit('delta', { threadId: 'thread-codex-1', turnId: 'turn-codex-1', delta: 'CLI=codex\nPWD=/tmp/demo' });
  codexClient.emit('turn:completed', {
    threadId: 'thread-codex-1',
    turn: { id: 'turn-codex-1', status: 'completed' },
  });

  await orchestrator.sendTaskInput('task-codex-turns', 'follow up');
  codexClient.emit('delta', { threadId: 'thread-codex-1', turnId: 'turn-codex-2', delta: 'FOLLOWUP=' });
  codexClient.emit('delta', { threadId: 'thread-codex-1', turnId: 'turn-codex-2', delta: 'FOLLOWUP=codex-ok' });
  codexClient.emit('turn:completed', {
    threadId: 'thread-codex-1',
    turn: { id: 'turn-codex-2', status: 'completed' },
  });

  const task = orchestrator.getTask('task-codex-turns');
  assert.equal(task.localSessionId, 'codex:task-codex-turns');
  assert.equal(task.turnId, 'turn-codex-2');
  assert.equal(task.outputBuffer, 'CLI=codex\nPWD=/tmp/demo\nFOLLOWUP=codex-ok');
  assert.equal(task.answerText, 'CLI=codex\nPWD=/tmp/demo\nFOLLOWUP=codex-ok');
  orchestrator.close();
});

test('codex structured follow-up inputs are queued until prior turn completes', async () => {
  const sendCalls = [];
  const codexClient = new EventEmitter();
  codexClient.submitPrompt = async () => ({
    threadId: 'thread-codex-queue-1',
    turnId: 'turn-codex-queue-1',
  });
  codexClient.sendInput = async ({ message }) => {
    sendCalls.push(message);
    return {
      threadId: 'thread-codex-queue-1',
      turnId: `turn-${sendCalls.length + 1}`,
    };
  };
  const orchestrator = new TaskOrchestrator({ client: null, sessionManager: null, codexClient });
  orchestrator.addTask({ id: 'task-codex-queue', prompt: 'first', sessionType: 'codex' });

  await orchestrator.submitTask('task-codex-queue');
  await orchestrator.sendTaskInput('task-codex-queue', 'second');
  await orchestrator.sendTaskInput('task-codex-queue', 'third');

  assert.deepEqual(sendCalls, []);

  codexClient.emit('delta', { threadId: 'thread-codex-queue-1', turnId: 'turn-codex-queue-1', delta: 'FIRST' });
  codexClient.emit('turn:completed', {
    threadId: 'thread-codex-queue-1',
    turn: { id: 'turn-codex-queue-1', status: 'completed' },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(sendCalls, ['second']);

  codexClient.emit('delta', { threadId: 'thread-codex-queue-1', turnId: 'turn-2', delta: 'SECOND' });
  codexClient.emit('turn:completed', {
    threadId: 'thread-codex-queue-1',
    turn: { id: 'turn-2', status: 'completed' },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(sendCalls, ['second', 'third']);

  codexClient.emit('delta', { threadId: 'thread-codex-queue-1', turnId: 'turn-3', delta: 'THIRD' });
  codexClient.emit('turn:completed', {
    threadId: 'thread-codex-queue-1',
    turn: { id: 'turn-3', status: 'completed' },
  });

  const task = orchestrator.getTask('task-codex-queue');
  assert.equal(task.outputBuffer, 'FIRST\nSECOND\nTHIRD');
  assert.equal(task.answerText, 'FIRST\nSECOND\nTHIRD');
  orchestrator.close();
});

test('submitTask routes claude tasks to json client by default', async () => {
  const calls = [];
  const claudeClient = {
    submitPrompt: async ({ sessionKey, prompt }) => {
      calls.push({ sessionKey, prompt });
      return { sessionKey, sessionId: 'claude-session-1', text: '我是 Claude' };
    },
  };
  const orchestrator = new TaskOrchestrator({
    client: null,
    sessionManager: null,
    claudeClient,
  });
  orchestrator.addTask({ id: 'task-claude-json-1', prompt: '你是谁', sessionType: 'claude' });

  const result = await orchestrator.submitTask('task-claude-json-1');
  const task = orchestrator.getTask('task-claude-json-1');

  assert.equal(calls.length, 1);
  assert.equal(result.raw.transport, 'json');
  assert.equal(result.raw.sessionId, 'claude:task-claude-json-1');
  assert.equal(task.localSessionId, 'claude:task-claude-json-1');
  assert.equal(task.localTransport, 'claude-json');
  assert.equal(task.answerText, '我是 Claude');
  assert.equal(task.turnStatus, 'completed');
  assert.equal(task.status, 'completed');
});

test('addTask rejects when max tasks reached under reject policy', async () => {
  const orchestrator = new TaskOrchestrator({ client: null, maxTasks: 1, overflowPolicy: 'reject' });
  orchestrator.addTask({ id: 'task-limit-1', prompt: 'a', sessionType: 'openclaw' });
  assert.throws(() => {
    orchestrator.addTask({ id: 'task-limit-2', prompt: 'b', sessionType: 'openclaw' });
  }, /Task capacity reached/);
  orchestrator.close();
});

test('orchestrator emits normalized run events from task lifecycle', async () => {
  const events = [];
  const client = {
    submitConversation: async () => ({ upstreamTaskId: 'up-1', status: 'accepted' }),
  };
  const orchestrator = new TaskOrchestrator({ client });
  orchestrator.on('run:event', (event) => events.push(event));

  orchestrator.addTask({ id: 'task-run-event-1', prompt: 'hello', sessionType: 'openclaw', metadata: { sessionKey: 'room-run-1' } });
  await orchestrator.submitTask('task-run-event-1');
  orchestrator.registerCallback('task-run-event-1', { message: 'done' });

  const types = events.map((event) => event.type);
  assert.ok(types.includes('run.created'));
  assert.ok(types.includes('run.started'));
  assert.ok(types.includes('run.updated'));
  assert.ok(types.includes('run.completed'));
  const completed = events.find((event) => event.type === 'run.completed');
  assert.equal(completed?.sessionKey, 'room-run-1');
  assert.equal(completed?.runId, 'run:task-run-event-1');
  orchestrator.close();
});

test('session capacity evicts oldest session under evict_oldest policy', async () => {
  const claudeClient = new FakeClaudeClient();
  const orchestrator = new TaskOrchestrator({
    client: null,
    sessionManager: null,
    claudeClient,
    maxSessions: 1,
    overflowPolicy: 'evict_oldest',
  });

  orchestrator.addTask({ id: 'task-s1', prompt: 'one', sessionType: 'claude', metadata: { sessionKey: 's1' } });
  await orchestrator.submitTask('task-s1');
  orchestrator.addTask({ id: 'task-s2', prompt: 'two', sessionType: 'claude', metadata: { sessionKey: 's2' } });
  await orchestrator.submitTask('task-s2');

  const sessions = claudeClient.listSessions().map((x) => x.id);
  assert.deepEqual(sessions, ['claude:s2']);
  orchestrator.close();
});

test('submitTask enforces single active task per session key and reuses session after completion', async () => {
  process.env.OPENCLAW_CODEX_TRANSPORT = 'cli';
  process.env.OPENCLAW_CLAUDE_TRANSPORT = 'cli';
  let createCount = 0;
  const sent = [];
  const fakeSession = new EventEmitter();
  fakeSession.id = 'claude-shared-room';
  fakeSession.send = (msg) => sent.push(msg);
  fakeSession.on = EventEmitter.prototype.on;
  const sessionManager = {
    createSession: (id) => {
      createCount += 1;
      fakeSession.id = id;
      return fakeSession;
    },
    send: (id, msg) => {
      sent.push(`${id}:${msg}`);
    },
  };
  const orchestrator = new TaskOrchestrator({ client: null, sessionManager });

  orchestrator.addTask({ id: 'task-a', prompt: 'first', sessionType: 'claude', metadata: { sessionKey: 'shared-room' } });
  orchestrator.addTask({ id: 'task-b', prompt: 'second', sessionType: 'claude', metadata: { sessionKey: 'shared-room' } });

  const resultA = await orchestrator.submitTask('task-a');
  await assert.rejects(
    () => orchestrator.submitTask('task-b'),
    (error) => error?.code === 'SESSION_BUSY',
  );
  fakeSession.emit('exit');
  const resultB = await orchestrator.submitTask('task-b');
  const taskB = orchestrator.getTask('task-b');

  assert.equal(createCount, 1);
  assert.equal(resultA.raw.sessionId, 'claude-shared-room');
  assert.equal(resultB.raw.sessionId, 'claude-shared-room');
  assert.equal(taskB.localSessionId, 'claude-shared-room');
  assert.deepEqual(sent, ['first', 'second']);

  orchestrator.sendTaskInput('task-b', 'follow up');
  assert.equal(sent.at(-1), 'claude-shared-room:follow up');

  fakeSession.emit('output', '\u001b[31mfinished\u001b[0m');
  assert.equal(orchestrator.getTask('task-b').lastCallbackPayload.data, 'finished');
  assert.equal(orchestrator.getTask('task-a').callbackCount || 0, 0);
  delete process.env.OPENCLAW_CODEX_TRANSPORT;
  delete process.env.OPENCLAW_CLAUDE_TRANSPORT;
});

test('local cli defaults include auto-approval args for claude and gemini', async () => {
  process.env.OPENCLAW_CLAUDE_TRANSPORT = 'cli';
  const created = [];
  const fakeSession = new EventEmitter();
  fakeSession.id = 'session-1';
  fakeSession.send = () => {};
  fakeSession.on = EventEmitter.prototype.on;
  const sessionManager = {
    createSession: (id, cliType, options) => {
      created.push({ id, cliType, options });
      fakeSession.id = id;
      return fakeSession;
    },
  };
  const orchestrator = new TaskOrchestrator({ client: null, sessionManager });

  orchestrator.addTask({ id: 'claude-1', prompt: 'hello', sessionType: 'claude' });
  orchestrator.addTask({ id: 'gemini-1', prompt: 'hello', sessionType: 'gemini' });

  await orchestrator.submitTask('claude-1');
  await orchestrator.submitTask('gemini-1');

  assert.deepEqual(created[0].options.args, ['--dangerously-skip-permissions']);
  assert.equal(created[0].options.env.IS_SANDBOX, process.env.IS_SANDBOX || '1');
  assert.deepEqual(created[1].options.args, ['--approval-mode', 'yolo', '--prompt-interactive', 'hello']);
  delete process.env.OPENCLAW_CLAUDE_TRANSPORT;
});

test('legacy gemini args are normalized when env still includes --yolo', async () => {
  process.env.OPENCLAW_GEMINI_ARGS = '--yolo --approval-mode yolo';
  const created = [];
  const fakeSession = new EventEmitter();
  fakeSession.id = 'gemini-session-1';
  fakeSession.send = () => {};
  fakeSession.on = EventEmitter.prototype.on;
  const sessionManager = {
    createSession: (id, cliType, options) => {
      created.push({ id, cliType, options });
      fakeSession.id = id;
      return fakeSession;
    },
  };
  const orchestrator = new TaskOrchestrator({ client: null, sessionManager });
  orchestrator.addTask({ id: 'gemini-legacy-1', prompt: 'legacy hello', sessionType: 'gemini' });

  await orchestrator.submitTask('gemini-legacy-1');

  assert.deepEqual(created[0].options.args, ['--approval-mode', 'yolo', '--prompt-interactive', 'legacy hello']);
  delete process.env.OPENCLAW_GEMINI_ARGS;
});

test('shared session output is mapped to the active task after sequential runs', async () => {
  process.env.OPENCLAW_CLAUDE_TRANSPORT = 'cli';
  const fakeSession = new EventEmitter();
  fakeSession.id = 'claude-room-x';
  fakeSession.send = () => {};
  fakeSession.on = EventEmitter.prototype.on;
  const sessionManager = {
    createSession: () => fakeSession,
    send: () => {},
  };
  const orchestrator = new TaskOrchestrator({ client: null, sessionManager });

  orchestrator.addTask({ id: 'task-1', prompt: 'first', sessionType: 'claude', metadata: { sessionKey: 'room-x' } });
  orchestrator.addTask({ id: 'task-2', prompt: 'second', sessionType: 'claude', metadata: { sessionKey: 'room-x' } });

  await orchestrator.submitTask('task-1');
  fakeSession.emit('output', 'answer for first');
  fakeSession.emit('exit');
  await orchestrator.submitTask('task-2');
  await orchestrator.sendTaskInput('task-2', 'follow second');
  fakeSession.emit('output', 'answer for second');
  fakeSession.emit('exit');

  assert.equal(orchestrator.getTask('task-1').lastCallbackPayload.data, 'answer for first');
  assert.equal(orchestrator.getTask('task-1').answerText, 'answer for first');
  assert.equal(orchestrator.getTask('task-1').turnStatus, 'completed');
  assert.equal(orchestrator.getTask('task-2').lastCallbackPayload.data, 'answer for second');
  assert.equal(orchestrator.getTask('task-2').answerText, 'answer for second');
  delete process.env.OPENCLAW_CLAUDE_TRANSPORT;
});

test('output buffer is truncated to max bytes', async () => {
  process.env.OPENCLAW_CLAUDE_TRANSPORT = 'cli';
  const fakeSession = new EventEmitter();
  fakeSession.id = 'claude-truncate-x';
  fakeSession.send = () => {};
  fakeSession.on = EventEmitter.prototype.on;
  const sessionManager = {
    createSession: () => fakeSession,
    send: () => {},
  };
  const orchestrator = new TaskOrchestrator({
    client: null,
    sessionManager,
    outputBufferMaxBytes: 40,
  });

  orchestrator.addTask({ id: 'task-truncate', prompt: 'first', sessionType: 'claude', metadata: { sessionKey: 'truncate-x' } });
  await orchestrator.submitTask('task-truncate');
  fakeSession.emit('output', 'line-1111111111');
  fakeSession.emit('output', 'line-2222222222');
  fakeSession.emit('output', 'line-3333333333');

  const task = orchestrator.getTask('task-truncate');
  assert.ok(Buffer.byteLength(task.outputBuffer || '', 'utf8') <= 40);
  delete process.env.OPENCLAW_CLAUDE_TRANSPORT;
  orchestrator.close();
});

test('sweep removes expired completed tasks and idle sessions', async () => {
  process.env.OPENCLAW_CLAUDE_TRANSPORT = 'json';
  const claudeClient = new FakeClaudeClient();
  const orchestrator = new TaskOrchestrator({
    client: null,
    sessionManager: null,
    claudeClient,
    sessionIdleTtlMs: 1000,
    taskRetentionMs: 1000,
  });
  orchestrator.addTask({ id: 'task-sweep', prompt: 'hello', sessionType: 'claude', metadata: { sessionKey: 'sweep-x' } });
  await orchestrator.submitTask('task-sweep');

  const now = Date.now() + 5_000;
  orchestrator.getTask('task-sweep').updatedAt = now - 10_000;
  orchestrator.sweep(now);

  assert.equal(orchestrator.getTask('task-sweep'), null);
  assert.equal(claudeClient.getSession('claude:sweep-x'), null);
  delete process.env.OPENCLAW_CLAUDE_TRANSPORT;
  orchestrator.close();
});

test('sendTaskInput uses claude json client for follow-up', async () => {
  process.env.OPENCLAW_CLAUDE_TRANSPORT = 'json';
  const inputs = [];
  const claudeClient = {
    submitPrompt: async ({ sessionKey }) => ({ sessionKey, sessionId: 'claude-s-1', text: 'first reply' }),
    sendInput: async ({ sessionKey, message }) => {
      inputs.push({ sessionKey, message });
      return { sessionId: 'claude-s-1', text: 'second reply' };
    },
  };
  const orchestrator = new TaskOrchestrator({ client: null, sessionManager: null, claudeClient });
  orchestrator.addTask({ id: 'task-claude-followup', prompt: 'first', sessionType: 'claude' });
  await orchestrator.submitTask('task-claude-followup');

  await orchestrator.sendTaskInput('task-claude-followup', 'follow up');
  const task = orchestrator.getTask('task-claude-followup');

  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].sessionKey, 'task-claude-followup');
  assert.equal(inputs[0].message, 'follow up');
  assert.match(task.answerText, /second reply/);
  assert.equal(task.status, 'completed');
  assert.equal(task.turnStatus, 'completed');
  delete process.env.OPENCLAW_CLAUDE_TRANSPORT;
  orchestrator.close();
});

test('bridged local session keeps history and mirrors turns to openclaw', async () => {
  process.env.OPENCLAW_CLAUDE_TRANSPORT = 'json';
  const mirrored = [];
  const client = {
    ensureSession: async ({ sessionKey }) => ({ ok: true, key: sessionKey }),
    injectSessionMessage: async (payload) => {
      mirrored.push(payload);
      return { ok: true };
    },
  };
  const claudeClient = {
    submitPrompt: async () => ({ sessionId: 'claude-s-bridge', text: 'first reply' }),
    sendInput: async () => ({ sessionId: 'claude-s-bridge', text: 'second reply' }),
  };
  const orchestrator = new TaskOrchestrator({ client, sessionManager: null, claudeClient });
  orchestrator.addTask({ id: 'task-bridge-1', prompt: 'first prompt', sessionType: 'claude' });

  await orchestrator.submitTask('task-bridge-1');
  await new Promise((resolve) => setTimeout(resolve, 0));
  await orchestrator.sendTaskInput('task-bridge-1', 'follow up');
  await new Promise((resolve) => setTimeout(resolve, 0));

  const history = orchestrator.getSessionHistory('claude:task-bridge-1');
  assert.equal(history.length, 4);
  assert.deepEqual(history.map((item) => item.role), ['user', 'assistant', 'user', 'assistant']);
  assert.equal(history[0].text, 'first prompt');
  assert.match(history[3].text, /second reply/);
  assert.equal(mirrored.length, 4);
  assert.ok(mirrored.some((entry) => /\[USER -> CLAUDE\]/.test(entry.message)));
  assert.ok(mirrored.some((entry) => /\[CLAUDE\]/.test(entry.message)));

  delete process.env.OPENCLAW_CLAUDE_TRANSPORT;
  orchestrator.close();
});

test('openclaw mirror injection preserves message order per session', async () => {
  process.env.OPENCLAW_CLAUDE_TRANSPORT = 'json';
  const mirrored = [];
  const client = {
    ensureSession: async ({ sessionKey }) => ({ ok: true, key: sessionKey }),
    injectSessionMessage: async ({ message }) => {
      const delay = message.includes('SECOND') ? 1 : 10;
      await new Promise((resolve) => setTimeout(resolve, delay));
      mirrored.push(message);
      return { ok: true };
    },
  };
  const claudeClient = {
    submitPrompt: async () => ({ sessionId: 'claude-order-1', text: 'FIRST' }),
    sendInput: async ({ message }) => ({ sessionId: 'claude-order-1', text: message.includes('SECOND') ? 'SECOND' : 'THIRD' }),
  };
  const orchestrator = new TaskOrchestrator({ client, sessionManager: null, claudeClient });
  orchestrator.addTask({ id: 'task-mirror-order-1', prompt: 'first prompt', sessionType: 'claude' });

  await orchestrator.submitTask('task-mirror-order-1');
  await orchestrator.sendTaskInput('task-mirror-order-1', 'send SECOND');
  await orchestrator.sendTaskInput('task-mirror-order-1', 'send THIRD');
  for (let i = 0; i < 20 && mirrored.length < 6; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.deepEqual(mirrored, [
    '[USER -> CLAUDE]\nfirst prompt',
    '[CLAUDE]\nFIRST',
    '[USER -> CLAUDE]\nsend SECOND',
    '[CLAUDE]\nSECOND',
    '[USER -> CLAUDE]\nsend THIRD',
    '[CLAUDE]\nTHIRD',
  ]);

  delete process.env.OPENCLAW_CLAUDE_TRANSPORT;
  orchestrator.close();
});

test('dispatchSessionMessage can trigger openclaw run for bridged session', async () => {
  process.env.OPENCLAW_CLAUDE_TRANSPORT = 'json';
  const sent = [];
  const client = {
    ensureSession: async ({ sessionKey }) => ({ ok: true, key: sessionKey }),
    injectSessionMessage: async () => ({ ok: true }),
    sendSessionMessage: async (payload) => {
      sent.push(payload);
      return { runId: 'dispatch-run-1', status: 'started' };
    },
  };
  const claudeClient = {
    submitPrompt: async () => ({ sessionId: 'claude-s-dispatch', text: 'reply' }),
  };
  const orchestrator = new TaskOrchestrator({ client, sessionManager: null, claudeClient });
  orchestrator.addTask({ id: 'task-dispatch-1', prompt: 'hello', sessionType: 'claude' });

  await orchestrator.submitTask('task-dispatch-1');
  const result = await orchestrator.dispatchSessionMessage('claude:task-dispatch-1', {
    message: 'analyze current state',
    target: 'openclaw',
    openclawMode: 'run',
  });

  assert.equal(result.openclaw.runId, 'dispatch-run-1');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].sessionKey, 'task-dispatch-1');

  delete process.env.OPENCLAW_CLAUDE_TRANSPORT;
  orchestrator.close();
});

test('pollInboundBridge forwards new openclaw user turns into local cli session', async () => {
  process.env.OPENCLAW_CLAUDE_TRANSPORT = 'json';
  const forwarded = [];
  let historyCalls = 0;
  const client = {
    ensureSession: async ({ sessionKey }) => ({ ok: true, key: sessionKey }),
    injectSessionMessage: async () => ({ ok: true }),
    getSessionHistory: async () => {
      historyCalls += 1;
      return {
        messages: historyCalls === 1 ? [
          {
            role: 'assistant',
            content: [{ type: 'text', text: '[bridge:user]\n\n[USER -> CLAUDE]\nignore mirrored' }],
            __openclaw: { seq: 1 },
          },
          {
            role: 'user',
            content: [{ type: 'text', text: 'implement feature x' }],
            __openclaw: { seq: 2 },
          },
        ] : [],
      };
    },
    abortSession: async () => ({ ok: true, aborted: true }),
  };
  const claudeClient = {
    submitPrompt: async () => ({ sessionId: 'claude-inbound-1', text: 'ready' }),
    sendInput: async ({ message }) => {
      forwarded.push(message);
      return { sessionId: 'claude-inbound-1', text: `done:${message}` };
    },
  };
  const orchestrator = new TaskOrchestrator({
    client,
    sessionManager: null,
    claudeClient,
    inboundBridgePollIntervalMs: 60_000,
  });
  orchestrator.addTask({ id: 'task-inbound-1', prompt: 'hello', sessionType: 'claude' });

  await orchestrator.submitTask('task-inbound-1');
  await orchestrator.pollInboundBridge();

  const task = orchestrator.getTask('task-inbound-1');
  assert.deepEqual(forwarded, ['implement feature x']);
  assert.equal(task.lastInboundSeq, 2);
  assert.equal(task.lastInput, 'implement feature x');

  delete process.env.OPENCLAW_CLAUDE_TRANSPORT;
  orchestrator.close();
});

test('gateway session.message forwards openclaw ui turn into local cli immediately', async () => {
  process.env.OPENCLAW_CLAUDE_TRANSPORT = 'json';
  const forwarded = [];
  const mirrored = [];
  const gatewaySubscriber = new EventEmitter();
  gatewaySubscriber.subscribeSession = async () => ({ subscribed: true });
  const client = {
    ensureSession: async ({ sessionKey }) => ({ ok: true, key: sessionKey }),
    injectSessionMessage: async (payload) => {
      mirrored.push(payload);
      return { ok: true };
    },
    abortSession: async () => ({ ok: true, aborted: true }),
  };
  const claudeClient = {
    submitPrompt: async () => ({ sessionId: 'claude-ws-1', text: 'ready' }),
    sendInput: async ({ message }) => {
      forwarded.push(message);
      return { sessionId: 'claude-ws-1', text: `done:${message}` };
    },
  };
  const orchestrator = new TaskOrchestrator({
    client,
    sessionManager: null,
    claudeClient,
    gatewaySubscriber,
    inboundBridgePollIntervalMs: 60_000,
  });
  orchestrator.addTask({ id: 'task-gateway-1', prompt: 'boot', sessionType: 'claude' });

  await orchestrator.submitTask('task-gateway-1');
  gatewaySubscriber.emit('session:message', {
    sessionKey: 'agent:main:task-gateway-1',
    messageSeq: 7,
    message: {
      role: 'user',
      content: 'ship it',
      __openclaw: { seq: 7 },
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const task = orchestrator.getTask('task-gateway-1');
  assert.deepEqual(forwarded, ['ship it']);
  assert.equal(task.lastInboundSeq, 7);
  assert.equal(task.lastInput, 'ship it');
  assert.equal(mirrored.some((entry) => entry.label === 'bridge:user' && /ship it/.test(entry.message)), false);

  delete process.env.OPENCLAW_CLAUDE_TRANSPORT;
  orchestrator.close();
});

test('gateway session.message accepts seq zero user turn by fingerprint', async () => {
  process.env.OPENCLAW_CLAUDE_TRANSPORT = 'json';
  const forwarded = [];
  const gatewaySubscriber = new EventEmitter();
  gatewaySubscriber.subscribeSession = async () => ({ subscribed: true });
  const client = {
    ensureSession: async ({ sessionKey }) => ({ ok: true, key: sessionKey }),
    injectSessionMessage: async () => ({ ok: true }),
    abortSession: async () => ({ ok: true, aborted: true }),
  };
  const claudeClient = {
    submitPrompt: async () => ({ sessionId: 'claude-ws-2', text: 'ready' }),
    sendInput: async ({ message }) => {
      forwarded.push(message);
      return { sessionId: 'claude-ws-2', text: `done:${message}` };
    },
  };
  const orchestrator = new TaskOrchestrator({
    client,
    sessionManager: null,
    claudeClient,
    gatewaySubscriber,
    inboundBridgePollIntervalMs: 60_000,
  });
  orchestrator.addTask({ id: 'task-gateway-2', prompt: 'boot', sessionType: 'claude' });

  await orchestrator.submitTask('task-gateway-2');
  const ts = Date.now();
  gatewaySubscriber.emit('session:message', {
    sessionKey: 'agent:main:task-gateway-2',
    messageSeq: 0,
    message: {
      role: 'user',
      content: 'seq zero input',
      timestamp: ts,
      __openclaw: { seq: 0 },
    },
  });
  gatewaySubscriber.emit('session:message', {
    sessionKey: 'agent:main:task-gateway-2',
    messageSeq: 0,
    message: {
      role: 'user',
      content: 'seq zero input',
      timestamp: ts,
      __openclaw: { seq: 0 },
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(forwarded, ['seq zero input']);

  delete process.env.OPENCLAW_CLAUDE_TRANSPORT;
  orchestrator.close();
});

test('gateway + poll do not duplicate seq zero inbound turn', async () => {
  process.env.OPENCLAW_CLAUDE_TRANSPORT = 'json';
  const forwarded = [];
  const gatewaySubscriber = new EventEmitter();
  gatewaySubscriber.subscribeSession = async () => ({ subscribed: true });
  const client = {
    ensureSession: async ({ sessionKey }) => ({ ok: true, key: sessionKey }),
    injectSessionMessage: async () => ({ ok: true }),
    abortSession: async () => ({ ok: true, aborted: true }),
    getSessionHistory: async () => ({
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'same inbound once' }],
          __openclaw: { seq: 0 },
        },
      ],
    }),
  };
  const claudeClient = {
    submitPrompt: async () => ({ sessionId: 'claude-ws-poll-1', text: 'ready' }),
    sendInput: async ({ message }) => {
      forwarded.push(message);
      return { sessionId: 'claude-ws-poll-1', text: `done:${message}` };
    },
  };
  const orchestrator = new TaskOrchestrator({
    client,
    sessionManager: null,
    claudeClient,
    gatewaySubscriber,
    inboundBridgePollIntervalMs: 60_000,
  });
  orchestrator.addTask({ id: 'task-gateway-poll-1', prompt: 'boot', sessionType: 'claude' });

  await orchestrator.submitTask('task-gateway-poll-1');
  gatewaySubscriber.emit('session:message', {
    sessionKey: 'agent:main:task-gateway-poll-1',
    messageSeq: 0,
    message: {
      role: 'user',
      content: 'same inbound once',
      __openclaw: { seq: 0 },
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await orchestrator.pollInboundBridge();

  assert.deepEqual(forwarded, ['same inbound once']);

  delete process.env.OPENCLAW_CLAUDE_TRANSPORT;
  orchestrator.close();
});

test('pollInboundBridge ignores untrusted metadata wrapper around bridge content', async () => {
  process.env.OPENCLAW_CLAUDE_TRANSPORT = 'json';
  const forwarded = [];
  const client = {
    ensureSession: async ({ sessionKey }) => ({ ok: true, key: sessionKey }),
    injectSessionMessage: async () => ({ ok: true }),
    getSessionHistory: async () => ({
      messages: [
        {
          role: 'user',
          content: [{
            type: 'text',
            text: 'Sender (untrusted metadata): [bridge:user]\n\n[USER -> CLAUDE]\nshould ignore',
          }],
          __openclaw: { seq: 12 },
        },
      ],
    }),
    abortSession: async () => ({ ok: true, aborted: true }),
  };
  const claudeClient = {
    submitPrompt: async () => ({ sessionId: 'claude-inbound-ignore-1', text: 'ready' }),
    sendInput: async ({ message }) => {
      forwarded.push(message);
      return { sessionId: 'claude-inbound-ignore-1', text: `done:${message}` };
    },
  };
  const orchestrator = new TaskOrchestrator({
    client,
    sessionManager: null,
    claudeClient,
    inboundBridgePollIntervalMs: 60_000,
  });
  orchestrator.addTask({ id: 'task-inbound-ignore-1', prompt: 'hello', sessionType: 'claude' });

  await orchestrator.submitTask('task-inbound-ignore-1');
  await orchestrator.pollInboundBridge();

  assert.deepEqual(forwarded, []);

  delete process.env.OPENCLAW_CLAUDE_TRANSPORT;
  orchestrator.close();
});

test('pollUpstreamTasks marks openclaw task completed from ws status snapshot', async () => {
  const client = {
    submitConversation: async () => ({
      upstreamTaskId: 'run-001',
      status: 'accepted',
      raw: { runId: 'run-001', status: 'started' },
    }),
    getWsSessionSnapshots: async () => new Map([[
      'oc-room-1',
      { key: 'agent:main:oc-room-1', updatedAt: Date.now() + 1000, outputTokens: 32, abortedLastRun: false },
    ]]),
  };
  const orchestrator = new TaskOrchestrator({ client, upstreamPollIntervalMs: 60_000 });
  orchestrator.addTask({
    id: 'task-openclaw-poll-1',
    prompt: 'hello',
    sessionType: 'openclaw',
    metadata: { sessionKey: 'oc-room-1' },
  });
  await orchestrator.submitTask('task-openclaw-poll-1');
  await orchestrator.pollUpstreamTasks();

  const task = orchestrator.getTask('task-openclaw-poll-1');
  assert.equal(task.status, 'completed');
  assert.equal(task.turnStatus, 'completed');
  assert.equal(task.lastCallbackPayload?.source, 'openclaw-status-poll');
  orchestrator.close();
});

test('pollUpstreamTasks marks openclaw task completed when upstream systemSent is true', async () => {
  const client = {
    submitConversation: async () => ({
      upstreamTaskId: 'run-001b',
      status: 'accepted',
      raw: { runId: 'run-001b', status: 'started' },
    }),
    getWsSessionSnapshots: async () => new Map([[
      'oc-room-1b',
      { key: 'agent:main:oc-room-1b', updatedAt: Date.now() + 1000, outputTokens: 0, systemSent: true, abortedLastRun: false },
    ]]),
  };
  const orchestrator = new TaskOrchestrator({ client, upstreamPollIntervalMs: 60_000 });
  orchestrator.addTask({
    id: 'task-openclaw-poll-1b',
    prompt: 'hello',
    sessionType: 'openclaw',
    metadata: { sessionKey: 'oc-room-1b' },
  });
  await orchestrator.submitTask('task-openclaw-poll-1b');
  await orchestrator.pollUpstreamTasks();

  const task = orchestrator.getTask('task-openclaw-poll-1b');
  assert.equal(task.status, 'completed');
  assert.equal(task.turnStatus, 'completed');
  assert.match(task.answerText, /OpenClaw run completed/);
  orchestrator.close();
});

test('pollUpstreamTasks marks openclaw task failed when snapshot aborted', async () => {
  const client = {
    submitConversation: async () => ({
      upstreamTaskId: 'run-002',
      status: 'accepted',
      raw: { runId: 'run-002', status: 'started' },
    }),
    getWsSessionSnapshots: async () => new Map([[
      'oc-room-2',
      { key: 'agent:main:oc-room-2', updatedAt: Date.now() + 1000, outputTokens: 0, abortedLastRun: true },
    ]]),
  };
  const orchestrator = new TaskOrchestrator({ client, upstreamPollIntervalMs: 60_000 });
  orchestrator.addTask({
    id: 'task-openclaw-poll-2',
    prompt: 'hello',
    sessionType: 'openclaw',
    metadata: { sessionKey: 'oc-room-2' },
  });
  await orchestrator.submitTask('task-openclaw-poll-2');
  await orchestrator.pollUpstreamTasks();

  const task = orchestrator.getTask('task-openclaw-poll-2');
  assert.equal(task.status, 'failed');
  assert.equal(task.turnStatus, 'failed');
  assert.match(task.error, /abortedLastRun=true/);
  orchestrator.close();
});

test('attachCallbackHandlers forwards session events', async () => {
  const orchestrator = new TaskOrchestrator({ client: { submitConversation: async () => ({}) } });
  const session = new EventEmitter();
  session.id = 'session-1';

  const events = [];
  orchestrator.on('session:output', (payload) => events.push(['output', payload]));
  orchestrator.on('session:exit', (payload) => events.push(['exit', payload]));

  orchestrator.attachCallbackHandlers(session);
  session.emit('output', 'hello');
  session.emit('exit');

  assert.equal(events.length, 2);
  assert.equal(events[0][1].sessionId, 'session-1');
  assert.equal(events[1][1].sessionId, 'session-1');
});

test('task lifecycle supports query, callback completion, terminate, and stats', async () => {
  const orchestrator = new TaskOrchestrator({
    client: {
      submitConversation: async () => ({ upstreamTaskId: 'upstream-2', status: 'accepted' }),
    },
  });

  orchestrator.addTask({ id: 'task-2', prompt: 'ping', sessionType: 'openclaw' });
  await orchestrator.submitTask('task-2');
  const taskAfterSubmit = orchestrator.getTask('task-2');
  assert.equal(taskAfterSubmit.status, 'submitted');

  orchestrator.registerCallback('task-2', { message: 'done' });
  const taskAfterCallback = orchestrator.getTask('task-2');
  assert.equal(taskAfterCallback.status, 'completed');
  assert.equal(taskAfterCallback.callbackCount, 1);

  orchestrator.terminateTask('task-2', 'manual-test');
  const taskAfterTerminate = orchestrator.getTask('task-2');
  assert.equal(taskAfterTerminate.status, 'terminated');
  assert.equal(taskAfterTerminate.terminateReason, 'manual-test');

  const stats = orchestrator.getTaskStats();
  assert.equal(stats.total, 1);
  assert.equal(stats.terminated, 1);
  orchestrator.close();
});
