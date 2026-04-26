import { WebSocketServer } from 'ws';

export function startWsServer(port, orchestrator) {
  const wss = new WebSocketServer({ port });

  orchestrator.on('session:registered', (session) => {
    broadcast(wss, { type: 'session_registered', session });
  });
  orchestrator.on('task:added', (task) => {
    broadcast(wss, { type: 'task_added', task });
  });
  orchestrator.on('task:submitted', (task) => {
    broadcast(wss, { type: 'task_submitted', task });
  });
  orchestrator.on('task:updated', (task) => {
    broadcast(wss, { type: 'task_updated', task });
  });
  orchestrator.on('task:terminated', (task) => {
    broadcast(wss, { type: 'task_terminated', task });
  });
  orchestrator.on('session:output', (payload) => {
    broadcast(wss, { type: 'session_output', ...payload });
  });
  orchestrator.on('session:message', (payload) => {
    broadcast(wss, { type: 'session_message', ...payload });
  });
  orchestrator.on('session:exit', (payload) => {
    broadcast(wss, { type: 'session_exit', ...payload });
  });
  orchestrator.on('run:event', (payload) => {
    broadcast(wss, { type: 'run_event', ...payload });
  });

  wss.on('connection', (ws) => {
    ws.on('message', async (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'submit_task') {
        const result = await orchestrator.submitTask(msg.task_id);
        ws.send(JSON.stringify({ type: 'task_submission_result', result }));
      }
    });
  });

  return wss;
}

function broadcast(wss, payload) {
  const message = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(message);
    }
  }
}
