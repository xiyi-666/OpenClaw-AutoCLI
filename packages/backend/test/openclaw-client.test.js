import assert from 'node:assert/strict';
import test from 'node:test';

import { OpenClawClient } from '../src/openclaw/OpenClawClient.js';

test('submitConversation sends callback url and task payload', async () => {
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init });
    return new Response(JSON.stringify({ task_id: 'upstream-1', status: 'accepted' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const client = new OpenClawClient({ baseUrl: 'http://127.0.0.1:18789', submitPath: '/api/tasks', transport: 'http' });
  const result = await client.submitConversation({
    taskId: 'task-1',
    prompt: 'hello',
    sessionType: 'claude',
    callbackBaseUrl: 'http://backend:8000',
    metadata: { kind: 'demo' },
  });

  assert.equal(result.upstreamTaskId, 'upstream-1');
  assert.equal(requests.length, 1);
  const body = JSON.parse(requests[0].init.body);
  assert.equal(body.task_id, 'task-1');
  assert.equal(body.callback_url, 'http://backend:8000/callbacks/openclaw');
  assert.equal(body.session_type, 'claude');
});

test('gateway helpers call create inject and send methods', async () => {
  const calls = [];
  const client = new OpenClawClient({
    baseUrl: 'http://127.0.0.1:18789',
    gatewayCallImpl: async (method, params) => {
      calls.push({ method, params });
      return { ok: true, method };
    },
  });

  await client.ensureSession({ sessionKey: 'bridge-room', label: 'Bridge Room' });
  await client.injectSessionMessage({ sessionKey: 'bridge-room', label: 'bridge:user', message: 'hello' });
  await client.sendSessionMessage({ sessionKey: 'bridge-room', message: 'run now', deliver: false, idempotencyKey: 'run-1' });

  assert.deepEqual(calls.map((entry) => entry.method), ['sessions.create', 'chat.inject', 'chat.send']);
  assert.equal(calls[0].params.key, 'bridge-room');
  assert.equal(calls[1].params.label, 'bridge:user');
  assert.equal(calls[2].params.idempotencyKey, 'run-1');
});
