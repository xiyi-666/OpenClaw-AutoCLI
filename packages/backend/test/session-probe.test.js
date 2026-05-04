import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { Probe } from '../src/probe/Probe.js';
import { Session } from '../src/session/SessionManager.js';

test('probe triggers task complete callback', () => {
  const session = new EventEmitter();
  session.id = 'session-1';
  session.tokenCount = 0;
  session.status = 'running';

  let completed = false;
  const orchestrator = {
    onTaskComplete: () => {
      completed = true;
    },
  };

  new Probe(session, orchestrator, { tokenThreshold: 1000 });
  session.emit('output', 'task complete');

  assert.equal(completed, true);
});

test('session send writes to child stdin when available', () => {
  const session = Object.create(Session.prototype);
  session.process = { stdin: { writable: true, write: (value) => { session.lastWrite = value; } } };
  session.status = 'running';

  Session.prototype.send.call(session, 'hello');

  assert.equal(session.lastWrite, 'hello\n');
});
