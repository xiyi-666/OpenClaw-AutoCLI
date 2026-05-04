import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';

import { OpenClawClient } from '../src/openclaw/OpenClawClient.js';
import { Probe } from '../src/probe/Probe.js';
import { SessionManager } from '../src/session/SessionManager.js';
import { TaskOrchestrator } from '../src/orchestrator/TaskOrchestrator.js';

test('full orchestration flow forwards task and reacts to session output', async () => {
  const clientRequests = [];
  const client = new OpenClawClient({
    baseUrl: 'http://127.0.0.1:18789',
    transport: 'http',
    fetchImpl: async (url, init) => {
      clientRequests.push({ url, init });
      return new Response(JSON.stringify({ task_id: 'upstream-1', status: 'accepted' }), { status: 200 });
    },
  });

  const sessionManager = new SessionManager({ sessionFactory: (id, cliType) => {
    const session = new EventEmitter();
    session.id = id;
    session.cliType = cliType;
    session.status = 'running';
    session.tokenCount = 0;
    session.send = () => {};
    session.kill = () => {};
    return session;
  }});

  const orchestrator = new TaskOrchestrator({ client, sessionManager });
  const session = sessionManager.createSession('session-1', 'claude');
  orchestrator.attachCallbackHandlers(session);
  new Probe(session, orchestrator, { tokenThreshold: 5 });

  orchestrator.addTask({ id: 'task-1', prompt: 'build app', sessionType: 'openclaw', callbackBaseUrl: 'http://backend:8000' });
  const result = await orchestrator.submitTask('task-1');
  session.emit('output', 'task complete');

  assert.equal(result.upstreamTaskId, 'upstream-1');
  assert.equal(clientRequests.length, 1);
  assert.equal(orchestrator.tasks.get('task-1').status, 'submitted');
});
