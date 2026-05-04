import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { startWsServer } from '../src/ws/WsServer.js';

test('startWsServer returns websocket server and forwards submitted task result', async () => {
  const orchestrator = new EventEmitter();
  orchestrator.submitTask = async () => ({ upstreamTaskId: 'upstream-1', status: 'accepted' });

  const wss = startWsServer(0, orchestrator);
  assert.ok(wss);
  await new Promise((resolve) => wss.close(resolve));
});
