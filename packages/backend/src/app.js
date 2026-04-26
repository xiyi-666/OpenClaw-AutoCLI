import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

import { ClaudeJsonClient } from './claude/ClaudeJsonClient.js';
import { CodexStructuredClient } from './codex/CodexStructuredClient.js';
import { OpenClawClient } from './openclaw/OpenClawClient.js';
import { OpenClawGatewaySubscriber } from './openclaw/OpenClawGatewaySubscriber.js';
import { TaskOrchestrator } from './orchestrator/TaskOrchestrator.js';
import { Probe } from './probe/Probe.js';
import { SessionManager } from './session/SessionManager.js';

export function createRuntime({
  client = new OpenClawClient({
    baseUrl: process.env.OPENCLAW_BASE_URL || 'http://127.0.0.1:18789',
    submitPath: process.env.OPENCLAW_SUBMIT_PATH || '/api/tasks',
    callbackPath: process.env.OPENCLAW_CALLBACK_PATH || '/callbacks/openclaw',
    apiKey: process.env.OPENCLAW_GATEWAY_TOKEN || process.env.OPENCLAW_API_KEY || '',
    timeoutMs: Number(process.env.OPENCLAW_TIMEOUT_MS || 15000),
  }),
  sessionManager = new SessionManager(),
  codexClient = new CodexStructuredClient(),
  claudeClient = new ClaudeJsonClient(),
  gatewaySubscriber = new OpenClawGatewaySubscriber(),
  orchestrator = null,
} = {}) {
  const runtimeOrchestrator = orchestrator || new TaskOrchestrator({
    client,
    sessionManager,
    codexClient,
    claudeClient,
    gatewaySubscriber,
  });

  sessionManager.on('session:created', (session) => {
    runtimeOrchestrator.registerSession(session);
    runtimeOrchestrator.attachCallbackHandlers(session);
    new Probe(session, runtimeOrchestrator);
  });

  if (process.env.OPENCLAW_CODEX_DEBUG === '1') {
    codexClient.on?.('notification', ({ method, params }) => {
      console.log('codex-notification', method, JSON.stringify(params));
    });
  }

  return {
    client,
    sessionManager,
    codexClient,
    claudeClient,
    gatewaySubscriber,
    orchestrator: runtimeOrchestrator,
  };
}

export function createAppServer({
  client,
  sessionManager,
  codexClient,
  claudeClient,
  orchestrator,
}) {
  const softTimeoutMs = Math.max(0, Number(process.env.OPENCLAW_HTTP_SOFT_TIMEOUT_MS || 2500));

  const normalizeTaskPayload = (payload) => {
    const normalized = { ...(payload || {}) };
    const runtime = String(normalized.runtime || '').trim().toLowerCase();
    if (!normalized.sessionType && runtime) {
      normalized.sessionType = runtime;
    }
    if (!normalized.id) {
      normalized.id = `task-${Date.now()}-${randomUUID().slice(0, 8)}`;
    }
    if (!normalized.runId) {
      normalized.runId = `run:${normalized.id}`;
    }
    if (!normalized.metadata || typeof normalized.metadata !== 'object') {
      normalized.metadata = {};
    }
    if (!normalized.sessionKey) {
      normalized.sessionKey = normalized.metadata.sessionKey || normalized.id;
    }
    normalized.metadata = {
      ...normalized.metadata,
      sessionKey: normalized.sessionKey,
    };
    return normalized;
  };

  const toRunPayload = (task) => {
    if (!task) return null;
    return {
      runId: task.runId || `run:${task.id}`,
      taskId: task.id,
      sessionKey: task.sessionKey || task.metadata?.sessionKey || task.id,
      runtime: String(task.sessionType || '').toLowerCase() || 'openclaw',
      status: task.status || 'unknown',
      answerText: task.answerText || '',
      error: task.error || null,
      submittedAt: task.submittedAt || null,
      updatedAt: task.updatedAt || null,
      completedAt: task.completedAt || null,
    };
  };

  const resolveTaskByRunRef = (runRef) => {
    const decoded = decodeURIComponent(String(runRef || ''));
    return orchestrator.getTaskByRunId(decoded) || orchestrator.getTask(decoded);
  };

  return createServer(async (req, res) => {
    const reqUrl = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = reqUrl.pathname;

    const sendJson = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    const readJson = async () => {
      let body = '';
      for await (const chunk of req) body += chunk;
      return body ? JSON.parse(body) : {};
    };

    const withSoftTimeout = async (promise, onTimeout) => {
      if (softTimeoutMs <= 0) {
        return { deferred: false, value: await promise };
      }
      let timer = null;
      const wrapped = Promise.resolve(promise)
        .then((value) => ({ kind: 'value', value }))
        .catch((error) => ({ kind: 'error', error }));
      const timeoutResult = await Promise.race([
        wrapped,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve({ kind: 'timeout' }), softTimeoutMs);
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (timeoutResult.kind === 'timeout') {
        wrapped.then((result) => {
          if (result.kind === 'error') {
            console.warn(`Deferred backend operation failed: ${result.error.message}`);
          }
        });
        return { deferred: true, value: onTimeout() };
      }
      if (timeoutResult.kind === 'error') {
        throw timeoutResult.error;
      }
      return { deferred: false, value: timeoutResult.value };
    };

    if (pathname === '/health') {
      const upstream = await client.health().catch((error) => ({ ok: false, error: error.message }));
      sendJson(200, { ok: true, service: 'openclaw-backend', upstream });
      return;
    }

    if (pathname === '/callbacks/openclaw' && req.method === 'POST') {
      const payload = await readJson();
      const taskId = payload.task_id || payload.session_id || null;
      orchestrator.emit('session:output', {
        sessionId: payload.session_id || payload.task_id || 'upstream',
        data: payload.message || JSON.stringify(payload),
      });
      orchestrator.registerCallback(taskId, payload);
      sendJson(200, { ok: true });
      return;
    }

    if (pathname === '/sessions' && req.method === 'POST') {
      const payload = await readJson();
      const session = sessionManager.createSession(payload.id, payload.cliType, payload.options || {});
      sendJson(200, { ok: true, session: { id: session.id, cliType: session.cliType, status: session.status } });
      return;
    }

    if (pathname === '/sessions' && req.method === 'GET') {
      sendJson(200, {
        ok: true,
        sessions: [...sessionManager.list(), ...codexClient.listSessions(), ...claudeClient.listSessions()],
      });
      return;
    }

    const sessionHistoryMatch = pathname.match(/^\/sessions\/([^/]+)\/history$/);
    if (sessionHistoryMatch && req.method === 'GET') {
      const requestedId = decodeURIComponent(sessionHistoryMatch[1]);
      const history = orchestrator.getSessionHistory(requestedId);
      if (!history) {
        sendJson(404, { ok: false, error: `Unknown session: ${requestedId}` });
        return;
      }
      sendJson(200, { ok: true, sessionId: requestedId, history });
      return;
    }

    const sessionDispatchMatch = pathname.match(/^\/sessions\/([^/]+)\/dispatch$/);
    if (sessionDispatchMatch && req.method === 'POST') {
      const requestedId = decodeURIComponent(sessionDispatchMatch[1]);
      const payload = await readJson();
      try {
        const result = await orchestrator.dispatchSessionMessage(requestedId, payload || {});
        sendJson(200, { ok: true, result });
      } catch (error) {
        sendJson(404, { ok: false, error: error.message });
      }
      return;
    }

    const sessionMatch = pathname.match(/^\/sessions\/([^/]+)$/);
    if (sessionMatch && req.method === 'GET') {
      const requestedId = decodeURIComponent(sessionMatch[1]);
      const session = sessionManager.get(requestedId) || codexClient.getSession(requestedId) || claudeClient.getSession(requestedId);
      const history = orchestrator.getSessionHistory(requestedId);
      if (!session && !history) {
        sendJson(404, { ok: false, error: `Unknown session: ${requestedId}` });
        return;
      }
      sendJson(200, {
        ok: true,
        session: {
          id: session?.id || requestedId,
          cliType: session?.cliType || null,
          status: session?.status || 'bridged',
          command: session?.command,
          args: session?.args,
          cwd: session?.cwd,
          threadId: session?.threadId || null,
          sessionKey: session?.sessionKey || null,
          transport: session?.transport || 'local-cli',
          historyCount: history?.length || 0,
        },
      });
      return;
    }

    const sessionInputMatch = pathname.match(/^\/sessions\/([^/]+)\/input$/);
    if (sessionInputMatch && req.method === 'POST') {
      const requestedId = decodeURIComponent(sessionInputMatch[1]);
      const payload = await readJson();
      try {
        const outcome = await withSoftTimeout((async () => {
          const session = sessionManager.get(requestedId);
          if (session) {
            sessionManager.send(requestedId, payload.message || '');
          } else {
            const codexSession = codexClient.getSession(requestedId);
            if (codexSession) {
              await codexClient.sendInput({
                sessionKey: codexSession.sessionKey || requestedId,
                threadId: codexSession.threadId,
                message: payload.message || '',
              });
            } else {
              const claudeSession = claudeClient.getSession(requestedId);
              if (!claudeSession) {
                throw new Error(`Unknown session: ${requestedId}`);
              }
              await claudeClient.sendInput({
                sessionKey: claudeSession.sessionKey,
                message: payload.message || '',
              });
            }
          }
          return { sessionId: requestedId };
        })(), () => ({ sessionId: requestedId }));
        sendJson(200, { ok: true, sessionId: requestedId, deferred: outcome.deferred, result: outcome.value });
      } catch (error) {
        sendJson(404, { ok: false, error: error.message });
      }
      return;
    }

    if (pathname === '/tasks' && req.method === 'GET') {
      sendJson(200, { ok: true, tasks: orchestrator.listTasks() });
      return;
    }

    if (pathname === '/tasks/stats' && req.method === 'GET') {
      sendJson(200, { ok: true, stats: orchestrator.getTaskStats() });
      return;
    }

    const taskMatch = pathname.match(/^\/tasks\/([^/]+)$/);
    if (taskMatch && req.method === 'GET') {
      const task = orchestrator.getTask(taskMatch[1]);
      if (!task) {
        sendJson(404, { ok: false, error: `Unknown task: ${taskMatch[1]}` });
        return;
      }
      sendJson(200, { ok: true, task });
      return;
    }

    const terminateMatch = pathname.match(/^\/tasks\/([^/]+)\/terminate$/);
    if (terminateMatch && req.method === 'POST') {
      try {
        const task = orchestrator.terminateTask(terminateMatch[1], 'api-request');
        sendJson(200, { ok: true, task });
      } catch (error) {
        sendJson(404, { ok: false, error: error.message });
      }
      return;
    }

    const taskInputMatch = pathname.match(/^\/tasks\/([^/]+)\/input$/);
    if (taskInputMatch && req.method === 'POST') {
      const payload = await readJson();
      try {
        const taskId = taskInputMatch[1];
        const outcome = await withSoftTimeout(
          orchestrator.sendTaskInput(taskId, payload.message || ''),
          () => orchestrator.getTask(taskId),
        );
        sendJson(200, { ok: true, task: outcome.value, deferred: outcome.deferred });
      } catch (error) {
        sendJson(404, { ok: false, error: error.message });
      }
      return;
    }

    if (pathname === '/tasks' && req.method === 'POST') {
      const payload = normalizeTaskPayload(await readJson());
      try {
        orchestrator.addTask(payload);
        const outcome = await withSoftTimeout(
          orchestrator.submitTask(payload.id),
          () => ({
            upstreamTaskId: null,
            status: 'submitted',
            deferred: true,
          }),
        );
        sendJson(200, {
          ok: true,
          result: outcome.value,
          task: orchestrator.getTask(payload.id),
          deferred: outcome.deferred,
        });
      } catch (error) {
        sendJson(502, {
          ok: false,
          error: error.message,
          status: error.status || 502,
          upstream: error.payload || null,
        });
      }
      return;
    }

    if (pathname === '/acp/runs' && req.method === 'POST') {
      const raw = await readJson();
      const payload = normalizeTaskPayload({
        ...raw,
        id: raw.taskId || raw.id || raw.runId || raw.idempotencyKey,
      });
      try {
        orchestrator.addTask(payload);
        const outcome = await withSoftTimeout(
          orchestrator.submitTask(payload.id),
          () => ({ status: 'submitted', deferred: true }),
        );
        const task = orchestrator.getTask(payload.id);
        sendJson(200, {
          ok: true,
          deferred: outcome.deferred,
          run: toRunPayload(task),
          result: outcome.value,
        });
      } catch (error) {
        const status = error.code === 'SESSION_BUSY' ? 409 : 502;
        sendJson(status, {
          ok: false,
          error: error.message,
          code: error.code || null,
          conflictTaskId: error.conflictTaskId || null,
        });
      }
      return;
    }

    const acpRunMatch = pathname.match(/^\/acp\/runs\/([^/]+)$/);
    if (acpRunMatch && req.method === 'GET') {
      const task = resolveTaskByRunRef(acpRunMatch[1]);
      if (!task) {
        sendJson(404, { ok: false, error: 'Unknown run' });
        return;
      }
      sendJson(200, { ok: true, run: toRunPayload(task), task });
      return;
    }

    const acpRunInputMatch = pathname.match(/^\/acp\/runs\/([^/]+)\/input$/);
    if (acpRunInputMatch && req.method === 'POST') {
      const payload = await readJson();
      const task = resolveTaskByRunRef(acpRunInputMatch[1]);
      if (!task) {
        sendJson(404, { ok: false, error: 'Unknown run' });
        return;
      }
      try {
        const outcome = await withSoftTimeout(
          orchestrator.sendTaskInput(task.id, payload.message || ''),
          () => orchestrator.getTask(task.id),
        );
        sendJson(200, { ok: true, deferred: outcome.deferred, run: toRunPayload(outcome.value), task: outcome.value });
      } catch (error) {
        sendJson(502, { ok: false, error: error.message });
      }
      return;
    }

    const acpRunTerminateMatch = pathname.match(/^\/acp\/runs\/([^/]+)\/terminate$/);
    if (acpRunTerminateMatch && req.method === 'POST') {
      const task = resolveTaskByRunRef(acpRunTerminateMatch[1]);
      if (!task) {
        sendJson(404, { ok: false, error: 'Unknown run' });
        return;
      }
      try {
        const terminated = orchestrator.terminateTask(task.id, 'acp-terminate');
        sendJson(200, { ok: true, run: toRunPayload(terminated), task: terminated });
      } catch (error) {
        sendJson(502, { ok: false, error: error.message });
      }
      return;
    }

    const acpSessionMatch = pathname.match(/^\/acp\/sessions\/([^/]+)$/);
    if (acpSessionMatch && req.method === 'GET') {
      const sessionKey = decodeURIComponent(acpSessionMatch[1]);
      const activeTask = orchestrator.getSessionActiveTask(sessionKey);
      const recent = orchestrator.listTasks()
        .filter((task) => String(task.sessionKey || task.metadata?.sessionKey || task.id) === sessionKey)
        .slice(0, 20)
        .map((task) => toRunPayload(task));
      sendJson(200, {
        ok: true,
        session: {
          sessionKey,
          activeRun: activeTask ? toRunPayload(activeTask) : null,
          runs: recent,
        },
      });
      return;
    }

    sendJson(200, { ok: true, service: 'openclaw-backend' });
  });
}
