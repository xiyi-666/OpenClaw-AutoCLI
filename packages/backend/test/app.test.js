import assert from 'node:assert/strict';
import test from 'node:test';

import { createAppServer, createRuntime } from '../src/app.js';

test('app exposes session history and dispatch endpoints', async () => {
  process.env.OPENCLAW_CLAUDE_TRANSPORT = 'json';
  const dispatches = [];
  const runtime = createRuntime({
    client: {
      health: async () => ({ ok: true }),
      ensureSession: async ({ sessionKey }) => ({ ok: true, key: sessionKey }),
      injectSessionMessage: async () => ({ ok: true }),
      sendSessionMessage: async (payload) => {
        dispatches.push(payload);
        return { runId: 'run-app-1', status: 'started' };
      },
    },
    claudeClient: {
      submitPrompt: async () => ({ sessionId: 'claude-app-1', text: 'hello from claude' }),
      listSessions: () => [],
      getSession: () => null,
      forgetSession: () => true,
    },
    codexClient: {
      on: () => {},
      listSessions: () => [],
      getSession: () => null,
      forgetSession: () => true,
    },
  });
  const server = createAppServer(runtime);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  runtime.orchestrator.addTask({ id: 'task-app-1', prompt: 'initial prompt', sessionType: 'claude' });
  await runtime.orchestrator.submitTask('task-app-1');
  await new Promise((resolve) => setTimeout(resolve, 0));

  const historyRes = await fetch(`${baseUrl}/sessions/claude%3Atask-app-1/history`);
  const historyPayload = await historyRes.json();
  assert.equal(historyPayload.ok, true);
  assert.equal(historyPayload.history.length, 2);

  const dispatchRes = await fetch(`${baseUrl}/sessions/claude%3Atask-app-1/dispatch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      message: 'run in openclaw too',
      target: 'openclaw',
      openclawMode: 'run',
    }),
  });
  const dispatchPayload = await dispatchRes.json();
  assert.equal(dispatchPayload.ok, true);
  assert.equal(dispatchPayload.result.openclaw.runId, 'run-app-1');
  assert.equal(dispatches.length, 1);

  await new Promise((resolve) => server.close(resolve));
  runtime.orchestrator.close();
  delete process.env.OPENCLAW_CLAUDE_TRANSPORT;
});

test('app returns deferred task submission when codex startup is slow', async () => {
  process.env.OPENCLAW_HTTP_SOFT_TIMEOUT_MS = '10';
  const runtime = createRuntime({
    client: {
      health: async () => ({ ok: true }),
    },
    codexClient: {
      on: () => {},
      submitPrompt: async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return { threadId: 'thread-slow-1', turnId: 'turn-slow-1' };
      },
      sendInput: async () => ({ threadId: 'thread-slow-1', turnId: 'turn-slow-2' }),
      listSessions: () => [],
      getSession: () => null,
      forgetSession: () => true,
    },
    claudeClient: {
      on: () => {},
      listSessions: () => [],
      getSession: () => null,
      forgetSession: () => true,
    },
  });
  const server = createAppServer(runtime);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  const res = await fetch(`${baseUrl}/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: 'task-codex-slow-1',
      prompt: 'reply slowly',
      sessionType: 'codex',
    }),
  });
  const payload = await res.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.deferred, true);
  assert.equal(payload.result.status, 'submitted');
  assert.equal(payload.task.status, 'submitted');

  await new Promise((resolve) => setTimeout(resolve, 60));
  const task = runtime.orchestrator.getTask('task-codex-slow-1');
  assert.equal(task.structuredThreadId, 'thread-slow-1');
  assert.equal(task.turnId, 'turn-slow-1');

  await new Promise((resolve) => server.close(resolve));
  runtime.orchestrator.close();
  delete process.env.OPENCLAW_HTTP_SOFT_TIMEOUT_MS;
});

test('app maps runtime field to sessionType for task submission', async () => {
  const runtime = createRuntime({
    client: {
      health: async () => ({ ok: true }),
    },
    codexClient: {
      on: () => {},
      submitPrompt: async () => ({ threadId: 'thread-runtime-1', turnId: 'turn-runtime-1' }),
      sendInput: async () => ({ threadId: 'thread-runtime-1', turnId: 'turn-runtime-2' }),
      listSessions: () => [],
      getSession: () => null,
      forgetSession: () => true,
    },
    claudeClient: {
      on: () => {},
      listSessions: () => [],
      getSession: () => null,
      forgetSession: () => true,
    },
  });
  const server = createAppServer(runtime);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  const res = await fetch(`${baseUrl}/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: 'task-runtime-map-1',
      prompt: 'reply via runtime alias',
      runtime: 'codex',
      metadata: { sessionKey: 'task-runtime-map-1' },
    }),
  });
  const payload = await res.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.task.sessionType, 'codex');
  assert.equal(payload.task.localSessionId, 'codex:task-runtime-map-1');
  assert.equal(payload.result.raw.transport, 'structured');

  await new Promise((resolve) => server.close(resolve));
  runtime.orchestrator.close();
});

test('app returns deferred task input when codex sendInput is slow', async () => {
  process.env.OPENCLAW_HTTP_SOFT_TIMEOUT_MS = '10';
  const runtime = createRuntime({
    client: {
      health: async () => ({ ok: true }),
    },
    codexClient: {
      on: () => {},
      submitPrompt: async () => ({ threadId: 'thread-input-slow-1', turnId: 'turn-input-slow-1' }),
      sendInput: async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return { threadId: 'thread-input-slow-1', turnId: 'turn-input-slow-2' };
      },
      listSessions: () => [],
      getSession: () => null,
      forgetSession: () => true,
    },
    claudeClient: {
      on: () => {},
      listSessions: () => [],
      getSession: () => null,
      forgetSession: () => true,
    },
  });
  runtime.orchestrator.addTask({ id: 'task-codex-input-slow-1', prompt: 'boot', sessionType: 'codex' });
  await runtime.orchestrator.submitTask('task-codex-input-slow-1');
  const seededTask = runtime.orchestrator.getTask('task-codex-input-slow-1');
  seededTask.turnStatus = 'completed';
  seededTask.completedAt = Date.now();

  const server = createAppServer(runtime);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  const res = await fetch(`${baseUrl}/tasks/task-codex-input-slow-1/input`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'follow up slowly' }),
  });
  const payload = await res.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.deferred, true);
  assert.equal(payload.task.lastInput, 'follow up slowly');

  await new Promise((resolve) => setTimeout(resolve, 60));
  const task = runtime.orchestrator.getTask('task-codex-input-slow-1');
  assert.equal(task.turnId, 'turn-input-slow-2');
  assert.equal(task.turnStatus, 'inProgress');

  await new Promise((resolve) => server.close(resolve));
  runtime.orchestrator.close();
  delete process.env.OPENCLAW_HTTP_SOFT_TIMEOUT_MS;
});

test('app exposes acp run endpoints', async () => {
  const runtime = createRuntime({
    client: {
      health: async () => ({ ok: true }),
    },
    codexClient: {
      on: () => {},
      submitPrompt: async () => ({ threadId: 'thread-acp-1', turnId: 'turn-acp-1' }),
      sendInput: async () => ({ threadId: 'thread-acp-1', turnId: 'turn-acp-2' }),
      listSessions: () => [],
      getSession: () => null,
      forgetSession: () => true,
    },
    claudeClient: {
      on: () => {},
      listSessions: () => [],
      getSession: () => null,
      forgetSession: () => true,
    },
  });
  const server = createAppServer(runtime);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  const createRes = await fetch(`${baseUrl}/acp/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      runId: 'run-acp-1',
      runtime: 'codex',
      prompt: 'acp prompt',
      sessionKey: 'acp-room-1',
    }),
  });
  const createPayload = await createRes.json();
  assert.equal(createPayload.ok, true);
  assert.equal(createPayload.run.runId, 'run-acp-1');
  assert.equal(createPayload.run.runtime, 'codex');

  const getRes = await fetch(`${baseUrl}/acp/runs/run-acp-1`);
  const getPayload = await getRes.json();
  assert.equal(getPayload.ok, true);
  assert.equal(getPayload.run.sessionKey, 'acp-room-1');

  const inputRes = await fetch(`${baseUrl}/acp/runs/run-acp-1/input`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'follow up acp' }),
  });
  const inputPayload = await inputRes.json();
  assert.equal(inputPayload.ok, true);
  assert.equal(inputPayload.task.lastInput, 'follow up acp');

  const sessionRes = await fetch(`${baseUrl}/acp/sessions/acp-room-1`);
  const sessionPayload = await sessionRes.json();
  assert.equal(sessionPayload.ok, true);
  assert.equal(sessionPayload.session.activeRun.runId, 'run-acp-1');

  const termRes = await fetch(`${baseUrl}/acp/runs/run-acp-1/terminate`, {
    method: 'POST',
  });
  const termPayload = await termRes.json();
  assert.equal(termPayload.ok, true);
  assert.equal(termPayload.run.status, 'terminated');

  await new Promise((resolve) => server.close(resolve));
  runtime.orchestrator.close();
});

test('app exposes acp session create/list/dispatch endpoints', async () => {
  const runtime = createRuntime({
    client: {
      health: async () => ({ ok: true }),
    },
    codexClient: {
      on: () => {},
      submitPrompt: async () => ({ threadId: 'thread-acpx-1', turnId: 'turn-acpx-1' }),
      sendInput: async () => ({ threadId: 'thread-acpx-1', turnId: 'turn-acpx-2' }),
      listSessions: () => [],
      getSession: () => null,
      forgetSession: () => true,
    },
    claudeClient: {
      on: () => {},
      listSessions: () => [],
      getSession: () => null,
      forgetSession: () => true,
    },
  });
  const server = createAppServer(runtime);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  const createRes = await fetch(`${baseUrl}/acp/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionKey: 'chat-room-1',
      label: 'CLAUDE / chat-room-1',
      model: 'claude-sonnet-4-20250514',
    }),
  });
  const createPayload = await createRes.json();
  assert.equal(createPayload.ok, true);
  assert.equal(createPayload.session.sessionKey, 'chat-room-1');

  const listRes = await fetch(`${baseUrl}/acp/sessions`);
  const listPayload = await listRes.json();
  assert.equal(listPayload.ok, true);
  assert.equal(Array.isArray(listPayload.sessions), true);
  assert.equal(listPayload.sessions.some((s) => s.sessionKey === 'chat-room-1'), true);

  const dispatchRes = await fetch(`${baseUrl}/acp/sessions/chat-room-1/dispatch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'hello acpx', target: 'local' }),
  });
  const dispatchPayload = await dispatchRes.json();
  assert.equal(dispatchPayload.ok, true);
  assert.equal(dispatchPayload.accepted, true);

  const getRes = await fetch(`${baseUrl}/acp/sessions/chat-room-1`);
  const getPayload = await getRes.json();
  assert.equal(getPayload.ok, true);
  assert.equal(Array.isArray(getPayload.session.messages), true);
  assert.equal(getPayload.session.messages.length >= 1, true);
  assert.equal(getPayload.session.messages[0].content, 'hello acpx');

  await new Promise((resolve) => server.close(resolve));
  runtime.orchestrator.close();
});

test('acp run creation rejects second active run in same session', async () => {
  const runtime = createRuntime({
    client: { health: async () => ({ ok: true }) },
    codexClient: {
      on: () => {},
      submitPrompt: async () => ({ threadId: 'thread-busy-1', turnId: 'turn-busy-1' }),
      sendInput: async () => ({ threadId: 'thread-busy-1', turnId: 'turn-busy-2' }),
      listSessions: () => [],
      getSession: () => null,
      forgetSession: () => true,
    },
    claudeClient: {
      on: () => {},
      listSessions: () => [],
      getSession: () => null,
      forgetSession: () => true,
    },
  });
  const server = createAppServer(runtime);
  try {
    await new Promise((resolve) => server.listen(0, resolve));
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;

    const first = await fetch(`${baseUrl}/acp/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        runId: 'run-acp-busy-1',
        runtime: 'codex',
        prompt: 'first',
        sessionKey: 'busy-room-1',
      }),
    });
    const firstPayload = await first.json();
    assert.equal(firstPayload.ok, true);

    const second = await fetch(`${baseUrl}/acp/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        runId: 'run-acp-busy-2',
        runtime: 'codex',
        prompt: 'second',
        sessionKey: 'busy-room-1',
      }),
    });
    const secondPayload = await second.json();
    assert.equal(second.status, 409);
    assert.equal(secondPayload.code, 'SESSION_BUSY');
    assert.equal(secondPayload.conflictTaskId, 'run-acp-busy-1');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    runtime.orchestrator.close();
  }
});

test('app supports acp run pause and resume endpoints', async () => {
  const runtime = createRuntime({
    client: { health: async () => ({ ok: true }) },
    codexClient: {
      on: () => {},
      submitPrompt: async () => ({ threadId: 'thread-control-1', turnId: 'turn-control-1' }),
      sendInput: async () => ({ threadId: 'thread-control-1', turnId: 'turn-control-2' }),
      listSessions: () => [],
      getSession: () => null,
      forgetSession: () => true,
    },
    claudeClient: {
      on: () => {},
      listSessions: () => [],
      getSession: () => null,
      forgetSession: () => true,
    },
  });
  const server = createAppServer(runtime);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  await fetch(`${baseUrl}/acp/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      runId: 'run-control-1',
      runtime: 'codex',
      prompt: 'hello',
      sessionKey: 'control-room-1',
    }),
  });

  const pauseRes = await fetch(`${baseUrl}/acp/runs/run-control-1/pause`, { method: 'POST' });
  const pausePayload = await pauseRes.json();
  assert.equal(pausePayload.ok, true);
  assert.equal(pausePayload.run.controlState, 'paused');

  const resumeRes = await fetch(`${baseUrl}/acp/runs/run-control-1/resume`, { method: 'POST' });
  const resumePayload = await resumeRes.json();
  assert.equal(resumePayload.ok, true);
  assert.equal(resumePayload.run.controlState, 'running');

  await new Promise((resolve) => server.close(resolve));
  runtime.orchestrator.close();
});

test('app bridge feishu event creates worker run and supports thread control', async () => {
  process.env.OPENCLAW_GATEWAY_TOKEN = 'test-gateway-token';
  const runtime = createRuntime({
    client: { health: async () => ({ ok: true }) },
    codexClient: {
      on: () => {},
      submitPrompt: async ({ sessionKey }) => ({ threadId: `thread-${sessionKey}`, turnId: 'turn-bridge-1' }),
      sendInput: async ({ threadId }) => ({ threadId, turnId: 'turn-bridge-2' }),
      listSessions: () => [],
      getSession: () => null,
      forgetSession: () => true,
    },
    claudeClient: {
      on: () => {},
      listSessions: () => [],
      getSession: () => null,
      forgetSession: () => true,
    },
  });
  const server = createAppServer(runtime);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  const bridgeRes = await fetch(`${baseUrl}/bridge/feishu/events`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer test-gateway-token',
    },
    body: JSON.stringify({
      type: 'message',
      agentId: 'agent-a',
      threadId: 'thread-a1',
      text: 'run worker',
      runtime: 'codex',
    }),
  });
  const bridgePayload = await bridgeRes.json();
  assert.equal(bridgePayload.ok, true);
  assert.equal(bridgePayload.run.agentId, 'agent-a');
  assert.equal(bridgePayload.run.threadId, 'thread-a1');

  const threadRes = await fetch(`${baseUrl}/bridge/threads/thread-a1`);
  const threadPayload = await threadRes.json();
  assert.equal(threadPayload.ok, true);
  assert.equal(threadPayload.thread.threadId, 'thread-a1');

  const pauseRes = await fetch(`${baseUrl}/bridge/threads/thread-a1/control`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'pause' }),
  });
  const pausePayload = await pauseRes.json();
  assert.equal(pausePayload.ok, true);
  assert.equal(pausePayload.run.controlState, 'paused');

  const resumeRes = await fetch(`${baseUrl}/bridge/threads/thread-a1/control`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'resume' }),
  });
  const resumePayload = await resumeRes.json();
  assert.equal(resumePayload.ok, true);
  assert.equal(resumePayload.run.controlState, 'running');

  await new Promise((resolve) => server.close(resolve));
  runtime.orchestrator.close();
  delete process.env.OPENCLAW_GATEWAY_TOKEN;
});

test('app bridge accepts openclaw channel envelope payload', async () => {
  process.env.OPENCLAW_GATEWAY_TOKEN = 'test-gateway-token';
  const runtime = createRuntime({
    client: { health: async () => ({ ok: true }) },
    codexClient: {
      on: () => {},
      submitPrompt: async ({ sessionKey }) => ({ threadId: `thread-${sessionKey}`, turnId: 'turn-oc-1' }),
      sendInput: async ({ threadId }) => ({ threadId, turnId: 'turn-oc-2' }),
      listSessions: () => [],
      getSession: () => null,
      forgetSession: () => true,
    },
    claudeClient: {
      on: () => {},
      listSessions: () => [],
      getSession: () => null,
      forgetSession: () => true,
    },
  });
  const server = createAppServer(runtime);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  const bridgeRes = await fetch(`${baseUrl}/bridge/openclaw/channel/events`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer test-gateway-token',
    },
    body: JSON.stringify({
      source: 'openclaw-channel',
      event: {
        eventType: 'chat.message',
        sessionKey: 'agent:agent-b',
        conversation_id: 'conv-b1',
        message: {
          content: [{ type: 'text', text: 'from official channel' }],
        },
        runtime: 'codex',
      },
    }),
  });
  const bridgePayload = await bridgeRes.json();
  assert.equal(bridgePayload.ok, true);
  assert.equal(bridgePayload.run.agentId, 'agent-b');
  assert.equal(bridgePayload.run.threadId, 'conv-b1');
  assert.equal(bridgePayload.sessionKey, 'agent:agent-b');

  const threadRes = await fetch(`${baseUrl}/bridge/threads/conv-b1`);
  const threadPayload = await threadRes.json();
  assert.equal(threadPayload.ok, true);
  assert.equal(threadPayload.thread.agentId, 'agent-b');
  assert.equal(threadPayload.thread.sessionKey, 'agent:agent-b');

  await new Promise((resolve) => server.close(resolve));
  runtime.orchestrator.close();
  delete process.env.OPENCLAW_GATEWAY_TOKEN;
});

 test('app creates isolated workspace cwd for new sessions by default', async () => {
  const created = [];
  const runtime = createRuntime({
    client: { health: async () => ({ ok: true }) },
    sessionManager: {
      createSession: (id, cliType, options) => {
        created.push({ id, cliType, options });
        return {
          id,
          cliType,
          status: 'running',
          command: options.command,
          args: options.args || [],
          cwd: options.cwd,
          send: () => {},
          on: () => {},
          kill: () => {},
        };
      },
      list: () => [],
      get: () => null,
      remove: () => {},
      send: () => {},
    },
    codexClient: {
      on: () => {},
      listSessions: () => [],
      getSession: () => null,
      forgetSession: () => true,
    },
    claudeClient: {
      on: () => {},
      listSessions: () => [],
      getSession: () => null,
      forgetSession: () => true,
    },
  });
  const server = createAppServer(runtime);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  const res = await fetch(`${baseUrl}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      cliType: 'claude',
      id: 'safe-session-1',
      options: { command: 'claude', args: ['--dangerously-skip-permissions'] },
    }),
  });
  const payload = await res.json();
  assert.equal(payload.ok, true);
  const normalizedCwd = String(created[0]?.options?.cwd || '').replaceAll('\\', '/');
  assert.equal(normalizedCwd.includes('.workspaces/claude/safe-session-1'), true);

  await new Promise((resolve) => server.close(resolve));
  runtime.orchestrator.close();
});
