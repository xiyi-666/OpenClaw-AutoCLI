import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

const ANSI_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b[@-_]/g;
const CONTROL_PATTERN = /[\u0000-\u0008\u000b-\u001f\u007f]/g;
const UI_NOISE_PATTERNS = [
  /^workspace \(/i,
  /^sandbox /i,
  /^YOLO /,
  /^\? for shortcuts$/i,
  /Type your message/i,
  /^> /,
  /^Authenticated /i,
  /^Waiting for authentication/i,
  /^Initializing/i,
  /^Warning:/i,
  /256-color support/i,
  /^YOLO Ctrl\+Y$/i,
  /^Gemini CLI/i,
  /^Update successful!/i,
  /^Installed with npm\./i,
  /Thinking\.\.\./i,
  /Generating /i,
  /Continuing to Process /i,
  /Crafting /i,
  /Completing Output/i,
  /Ready \(backend\)/i,
  /^Options:$/i,
  /^Commands:$/i,
  /^Arguments:$/i,
  /^Usage:/i,
  /^Not logged in/i,
  /^RECATED:/,
  /^Gemini CLI update available!/i,
  /^\/mnt\/.*gemini-[0-9.:-]+/i,
  /^[╭╰│─┌┐└┘]+$/,
  /^[▀▄▝▜▗▟]+$/,
  /^[⏵❯]+/,
  /^Claude Code/i,
  /^Tips for getting started/i,
  /^Recent activity/i,
  /^No recent activity/i,
  /^accept edits on/i,
  /^>0q$/,
];

const DEFAULT_MAX_TASKS = Number(process.env.OPENCLAW_MAX_TASKS || 500);
const DEFAULT_MAX_SESSIONS = Number(process.env.OPENCLAW_MAX_SESSIONS || 100);
const DEFAULT_SESSION_IDLE_TTL_MS = Number(process.env.OPENCLAW_SESSION_IDLE_TTL_MS || 30 * 60 * 1000);
const DEFAULT_TASK_RETENTION_MS = Number(process.env.OPENCLAW_TASK_RETENTION_MS || 15 * 60 * 1000);
const DEFAULT_SWEEP_INTERVAL_MS = Number(process.env.OPENCLAW_SWEEP_INTERVAL_MS || 30 * 1000);
const DEFAULT_OUTPUT_BUFFER_MAX_BYTES = Number(process.env.OPENCLAW_OUTPUT_BUFFER_MAX_BYTES || 64 * 1024);
const DEFAULT_UPSTREAM_POLL_INTERVAL_MS = Number(process.env.OPENCLAW_UPSTREAM_POLL_INTERVAL_MS || 2000);
const DEFAULT_INBOUND_BRIDGE_POLL_INTERVAL_MS = Number(process.env.OPENCLAW_INBOUND_BRIDGE_POLL_INTERVAL_MS || 1500);
const DEFAULT_INTERRUPT_TTL_MS = Number(process.env.OPENCLAW_INTERRUPT_TTL_MS || 8 * 60 * 60 * 1000);
const DEFAULT_TERMINATED_RETENTION_MS = Number(process.env.OPENCLAW_TERMINATED_RETENTION_MS || 5 * 60 * 60 * 1000);

export class TaskOrchestrator extends EventEmitter {
  constructor({
    client,
    sessionManager,
    probe,
    codexClient,
    claudeClient,
    openCodeClient,
    gatewaySubscriber,
    logger = console,
    maxTasks = DEFAULT_MAX_TASKS,
    maxSessions = DEFAULT_MAX_SESSIONS,
    sessionIdleTtlMs = DEFAULT_SESSION_IDLE_TTL_MS,
    taskRetentionMs = DEFAULT_TASK_RETENTION_MS,
    sweepIntervalMs = DEFAULT_SWEEP_INTERVAL_MS,
    outputBufferMaxBytes = DEFAULT_OUTPUT_BUFFER_MAX_BYTES,
    upstreamPollIntervalMs = DEFAULT_UPSTREAM_POLL_INTERVAL_MS,
    inboundBridgePollIntervalMs = DEFAULT_INBOUND_BRIDGE_POLL_INTERVAL_MS,
    overflowPolicy = process.env.OPENCLAW_OVERFLOW_POLICY || 'reject',
    interruptTtlMs = DEFAULT_INTERRUPT_TTL_MS,
    terminatedRetentionMs = DEFAULT_TERMINATED_RETENTION_MS,
  } = {}) {
    super();
    this.client = client;
    this.sessionManager = sessionManager;
    this.probe = probe;
    this.codexClient = codexClient;
    this.claudeClient = claudeClient;
    this.openCodeClient = openCodeClient;
    this.gatewaySubscriber = gatewaySubscriber;
    this.logger = logger;
    this.tasks = new Map();
    this.sessions = new Map();
    this.taskBySession = new Map();
    this.boundSessions = new Set();
    this.sessionLastActive = new Map();
    this.sessionMessages = new Map();
    this.openClawMirrors = new Set();
    this.openClawMirrorChains = new Map();
    this.assistantTurnTimers = new Map();
    this.maxTasks = Number.isFinite(maxTasks) ? Math.max(1, maxTasks) : DEFAULT_MAX_TASKS;
    this.maxSessions = Number.isFinite(maxSessions) ? Math.max(1, maxSessions) : DEFAULT_MAX_SESSIONS;
    this.sessionIdleTtlMs = Number.isFinite(sessionIdleTtlMs) ? Math.max(1, sessionIdleTtlMs) : DEFAULT_SESSION_IDLE_TTL_MS;
    this.taskRetentionMs = Number.isFinite(taskRetentionMs) ? Math.max(1, taskRetentionMs) : DEFAULT_TASK_RETENTION_MS;
    this.sweepIntervalMs = Number.isFinite(sweepIntervalMs) ? Math.max(1, sweepIntervalMs) : DEFAULT_SWEEP_INTERVAL_MS;
    this.outputBufferMaxBytes = Number.isFinite(outputBufferMaxBytes) ? Math.max(1, outputBufferMaxBytes) : DEFAULT_OUTPUT_BUFFER_MAX_BYTES;
    this.upstreamPollIntervalMs = Number.isFinite(upstreamPollIntervalMs) ? Math.max(500, upstreamPollIntervalMs) : DEFAULT_UPSTREAM_POLL_INTERVAL_MS;
    this.inboundBridgePollIntervalMs = Number.isFinite(inboundBridgePollIntervalMs) ? Math.max(500, inboundBridgePollIntervalMs) : DEFAULT_INBOUND_BRIDGE_POLL_INTERVAL_MS;
    this.overflowPolicy = overflowPolicy === 'evict_oldest' ? 'evict_oldest' : 'reject';
    this.interruptTtlMs = Number.isFinite(interruptTtlMs) ? Math.max(1, interruptTtlMs) : DEFAULT_INTERRUPT_TTL_MS;
    this.terminatedRetentionMs = Number.isFinite(terminatedRetentionMs) ? Math.max(1, terminatedRetentionMs) : DEFAULT_TERMINATED_RETENTION_MS;
    this.isPollingUpstream = false;
    this.isPollingInboundBridge = false;
    this.sweepTimer = setInterval(() => {
      this.sweep();
    }, this.sweepIntervalMs);
    this.upstreamPollTimer = setInterval(() => {
      this.pollUpstreamTasks().catch((error) => {
        this.logger?.warn?.(`OpenClaw upstream poll failed: ${error.message}`);
      });
    }, this.upstreamPollIntervalMs);
    this.inboundBridgePollTimer = setInterval(() => {
      this.pollInboundBridge().catch((error) => {
        this.logger?.warn?.(`OpenClaw inbound bridge poll failed: ${error.message}`);
      });
    }, this.inboundBridgePollIntervalMs);
    if (typeof this.sweepTimer.unref === 'function') {
      this.sweepTimer.unref();
    }
    if (typeof this.upstreamPollTimer.unref === 'function') {
      this.upstreamPollTimer.unref();
    }
    if (typeof this.inboundBridgePollTimer.unref === 'function') {
      this.inboundBridgePollTimer.unref();
    }

    if (this.codexClient?.on) {
      this.codexClient.on('delta', ({ threadId, turnId, delta }) => {
        const taskId = this.taskBySession.get(threadId);
        if (!taskId) return;
        const task = this.tasks.get(taskId);
        if (!task) return;
        const cleanData = this.#normalizeStructuredDelta(delta);
        if (!cleanData) return;
        if (turnId && task.turnId && turnId !== task.turnId) {
          this.#commitStructuredTurnOutput(task);
          this.#finalizeAssistantMessage(task);
        }
        if (turnId) {
          task.turnId = turnId;
        }
        task.structuredTurnText = this.#mergeStructuredTurnText(task.structuredTurnText || '', cleanData);
        this.#upsertAssistantMessage(task, task.structuredTurnText, {
          source: 'codex-structured',
          turnId: turnId || task.turnId || null,
          replace: true,
        });
        const combinedText = this.#combineStructuredOutput(task);
        task.callbackCount = (task.callbackCount || 0) + 1;
        task.lastCallbackAt = Date.now();
        this.#touchSession(task.localSessionId || `codex:${task.sessionKey || ''}`);
        task.lastCallbackPayload = {
          source: 'codex-structured',
          data: combinedText,
          extractedAnswer: this.#extractAnswerText(combinedText),
        };
        task.answerText = task.lastCallbackPayload.extractedAnswer;
        task.updatedAt = Date.now();
        this.emit('task:updated', task);
        this.emit('session:output', { sessionId: task.localSessionId || threadId, data: combinedText });
      });
      this.codexClient.on('turn:completed', ({ threadId, turn }) => {
        const taskId = this.taskBySession.get(threadId);
        if (!taskId) return;
        const task = this.tasks.get(taskId);
        if (!task) return;
        this.#commitStructuredTurnOutput(task);
        this.#finalizeAssistantMessage(task);
        const combinedText = this.#combineStructuredOutput(task);
        if (combinedText) {
          task.answerText = this.#extractAnswerText(combinedText);
          if (task.lastCallbackPayload?.source === 'codex-structured') {
            task.lastCallbackPayload = {
              ...task.lastCallbackPayload,
              data: combinedText,
              extractedAnswer: task.answerText,
            };
          }
        }
        if (task.status !== 'terminated' && task.status !== 'failed') {
          task.status = 'completed';
          task.completedAt = Date.now();
          task.turnId = turn?.id || task.turnId || null;
          task.turnStatus = turn?.status || 'completed';
          task.updatedAt = Date.now();
          this.emit('task:updated', task);
        }
        this.#drainStructuredInputQueue(task).catch((error) => {
          task.status = 'failed';
          task.turnStatus = 'failed';
          task.error = error.message;
          task.updatedAt = Date.now();
          this.emit('task:updated', task);
        });
      });
    }

    if (this.gatewaySubscriber?.on) {
      this.gatewaySubscriber.on('session:message', (payload) => {
        this.#handleGatewaySessionMessage(payload).catch((error) => {
          this.logger?.warn?.(`OpenClaw inbound session message failed: ${error.message}`);
        });
      });
    }

    this.on('task:added', (task) => {
      this.#emitRunEvent('run.created', task);
    });
    this.on('task:submitted', (task) => {
      this.#emitRunEvent('run.started', task);
    });
    this.on('task:updated', (task) => {
      this.#emitRunEvent('run.updated', task);
      if (task?.lastCallbackAt) {
        this.#emitRunEvent('run.output.delta', task, {
          message: task?.lastCallbackPayload?.extractedAnswer || task?.lastCallbackPayload?.data || '',
        });
      }
      if (task?.status === 'completed') {
        this.#emitRunEvent('run.completed', task, {
          message: task?.answerText || '',
        });
      } else if (task?.status === 'failed') {
        this.#emitRunEvent('run.failed', task, {
          message: task?.error || 'run failed',
        });
      }
    });
    this.on('task:terminated', (task) => {
      this.#emitRunEvent('run.terminated', task, {
        message: task?.terminateReason || 'terminated',
      });
    });
  }

  close() {
    for (const timer of this.assistantTurnTimers.values()) {
      clearTimeout(timer);
    }
    this.assistantTurnTimers.clear();
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    if (this.upstreamPollTimer) {
      clearInterval(this.upstreamPollTimer);
      this.upstreamPollTimer = null;
    }
    if (this.inboundBridgePollTimer) {
      clearInterval(this.inboundBridgePollTimer);
      this.inboundBridgePollTimer = null;
    }
  }

  registerSession(session) {
    this.sessions.set(session.id, session);
    this.#touchSession(session.id);
    this.emit('session:registered', session);
  }

  addTask(task) {
    if (!task?.id) throw new Error('Task id is required');
    if (!this.tasks.has(task.id)) {
      this.#ensureTaskCapacity();
    }
    const now = Date.now();
    const existing = this.tasks.get(task.id);
    const nextTask = {
      ...(existing || {}),
      ...task,
      runId: task.runId || existing?.runId || `run:${task.id}`,
      sessionKey: task.sessionKey || task.metadata?.sessionKey || existing?.sessionKey || task.id,
      controlState: task.controlState || existing?.controlState || 'running',
      attempt: Number(task.attempt || existing?.attempt || 1),
      status: task.status || existing?.status || 'queued',
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      callbackCount: existing?.callbackCount || 0,
      answerText: existing?.answerText || '',
      outputBuffer: existing?.outputBuffer || '',
      turnStatus: existing?.turnStatus || null,
    };
    this.tasks.set(task.id, nextTask);
    this.emit('task:added', nextTask);
    this.emit('task:updated', nextTask);
  }

  async submitTask(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Unknown task: ${taskId}`);

    const sessionType = String(task.sessionType || '').toLowerCase();
    const useLocalCli = sessionType === 'codex' || sessionType === 'claude' || sessionType === 'gemini' || sessionType === 'opencode';
    this.#assertSessionAvailability(task);

    task.status = 'submitted';
    task.submittedAt = Date.now();
    task.updatedAt = Date.now();
    this.emit('task:submitted', task);
    this.emit('task:updated', task);

    try {
      let result;
      if (useLocalCli) {
        result = await this.#submitLocalCliTask(task);
      } else {
        if (!this.client) throw new Error('OpenClaw client is not configured');
        const payload = {
          taskId: task.id,
          prompt: task.prompt,
          sessionType: task.sessionType,
          metadata: task.metadata || {},
          callbackBaseUrl: task.callbackBaseUrl,
        };
        result = await this.client.submitConversation(payload);
      }
      task.upstreamTaskId = result?.upstreamTaskId || task.upstreamTaskId || null;
      task.lastSubmitResult = result || null;
      if (sessionType === 'openclaw') {
        task.upstreamRunId = result?.raw?.runId || task.upstreamTaskId || null;
        task.upstreamSessionKey = task.metadata?.sessionKey || task.id;
        task.upstreamObservedAt = 0;
      }
      task.updatedAt = Date.now();
      this.emit('task:updated', task);
      return result;
    } catch (error) {
      task.status = 'failed';
      task.error = error.message;
      task.updatedAt = Date.now();
      this.emit('task:updated', task);
      throw error;
    }
  }

  async #submitLocalCliTask(task) {
    const cliType = String(task.sessionType || '').toLowerCase();
    if (cliType === 'codex' && this.#shouldUseStructuredCodex()) {
      return this.#submitStructuredCodexTask(task);
    }
    if (cliType === 'claude' && this.#shouldUseClaudeJson() && this.claudeClient) {
      return this.#submitClaudeJsonTask(task);
    }
    if (cliType === 'opencode' && this.openCodeClient) {
      return this.#submitOpenCodeTask(task);
    }
    if (!this.sessionManager) {
      throw new Error('Session manager is required for local CLI session');
    }
    const command = process.env[`OPENCLAW_${cliType.toUpperCase()}_CMD`] || cliType;
    const defaultArgs = this.#defaultCliArgs(cliType);
    const rawArgs = process.env[`OPENCLAW_${cliType.toUpperCase()}_ARGS`] || defaultArgs;
    let args = rawArgs
      .split(' ')
      .map((x) => x.trim())
      .filter(Boolean);
    args = this.#normalizeCliArgs(cliType, args);
    const sessionKey = task.metadata?.sessionKey || task.localSessionId || task.id;
    const sessionId = `${cliType}-${sessionKey}`;
    this.#ensureSessionCapacity(sessionId);

    let session = this.sessions.get(sessionId);
    let shouldSendPrompt = true;
    if (!session) {
      if (cliType === 'gemini' && task.prompt) {
        args = [...args, '--prompt-interactive', task.prompt];
        shouldSendPrompt = false;
      }
      session = this.sessionManager.createSession(sessionId, cliType, {
        command,
        args,
        cwd: process.cwd(),
        env: this.#buildCliEnv(cliType),
      });
      this.sessions.set(sessionId, session);
      this.taskBySession.set(sessionId, task.id);
      this.attachCallbackHandlers(session);
      session.on('exit', () => {
        const linkedTaskId = this.taskBySession.get(sessionId);
        const linkedTask = linkedTaskId ? this.tasks.get(linkedTaskId) : null;
        if (!linkedTask) return;
        if (linkedTask.status !== 'terminated' && linkedTask.status !== 'failed') {
          this.#finalizeLocalTask(linkedTask);
          linkedTask.status = 'completed';
          linkedTask.completedAt = Date.now();
          linkedTask.updatedAt = Date.now();
          this.emit('task:updated', linkedTask);
        }
      });
    }

    if (!task.localSessionId) {
      task.localSessionId = sessionId;
      task.sessionKey = sessionKey;
      task.updatedAt = Date.now();
      this.emit('task:updated', task);
    }
    this.#recordSessionMessage(task, {
      role: 'user',
      text: task.prompt || '',
      source: 'task-submit',
      finalize: true,
    });

    this.taskBySession.set(sessionId, task.id);
    this.#touchSession(sessionId);

    if (shouldSendPrompt) {
      session.send(task.prompt || '');
    }
    return {
      upstreamTaskId: sessionId,
      status: 'started',
      raw: {
        transport: 'local-cli',
        cliType,
        command,
        args,
        sessionId,
        sessionKey,
      },
    };
  }

  #defaultCliArgs(cliType) {
    if (cliType === 'codex') {
      return `--ask-for-approval never --sandbox danger-full-access -c model_reasoning_effort=high --no-alt-screen -C ${process.cwd()}`;
    }
    if (cliType === 'claude') {
      return '--dangerously-skip-permissions';
    }
    if (cliType === 'gemini') {
      return '--approval-mode yolo';
    }
    return '';
  }

  #normalizeCliArgs(cliType, args) {
    if (cliType !== 'gemini') return args;
    const hasApprovalMode = args.some((arg) => arg === '--approval-mode' || arg.startsWith('--approval-mode='));
    const hadYolo = args.includes('--yolo');
    const cleaned = args.filter((arg) => arg !== '--yolo');
    if (!hasApprovalMode && hadYolo) {
      cleaned.push('--approval-mode', 'yolo');
    }
    return cleaned;
  }

  #buildCliEnv(cliType) {
    if (cliType !== 'claude') return process.env;
    return {
      ...process.env,
      IS_SANDBOX: process.env.IS_SANDBOX || '1',
    };
  }

  #shouldUseStructuredCodex() {
    return (process.env.OPENCLAW_CODEX_TRANSPORT || 'structured') === 'structured';
  }

  #shouldUseClaudeJson() {
    return (process.env.OPENCLAW_CLAUDE_TRANSPORT || 'json') === 'json';
  }

  async #submitStructuredCodexTask(task) {
    if (!this.codexClient) {
      throw new Error('Codex structured client is not configured');
    }
    const sessionKey = task.metadata?.sessionKey || task.sessionKey || task.id;
    const sessionId = `codex:${sessionKey}`;
    this.#ensureSessionCapacity(sessionId);
    task.localSessionId = sessionId;
    task.sessionKey = sessionKey;
    this.#recordSessionMessage(task, {
      role: 'user',
      text: task.prompt || '',
      source: 'task-submit',
      finalize: true,
    });
    const model = String(task.metadata?.model || '').trim();
    const result = await this.codexClient.submitPrompt({
      sessionKey,
      prompt: task.prompt || '',
      cwd: process.cwd(),
      model,
    });
    task.structuredThreadId = result.threadId;
    task.turnId = result.turnId;
    task.structuredTurnText = '';
    task.turnStatus = 'inProgress';
    task.updatedAt = Date.now();
    this.taskBySession.set(sessionId, task.id);
    this.taskBySession.set(result.threadId, task.id);
    this.#touchSession(sessionId);
    this.emit('task:updated', task);
    return {
      upstreamTaskId: result.threadId,
      status: 'started',
      raw: {
        transport: 'structured',
        cliType: 'codex',
        sessionId,
        sessionKey,
        threadId: result.threadId,
        turnId: result.turnId,
      },
    };
  }

  async #submitClaudeJsonTask(task) {
    if (!this.claudeClient) {
      throw new Error('Claude JSON client is not configured');
    }
    const sessionKey = task.metadata?.sessionKey || task.sessionKey || task.id;
    const sessionId = `claude:${sessionKey}`;
    this.#ensureSessionCapacity(sessionId);
    task.localSessionId = sessionId;
    task.sessionKey = sessionKey;
    this.#recordSessionMessage(task, {
      role: 'user',
      text: task.prompt || '',
      source: 'task-submit',
      finalize: true,
    });
    const result = await this.claudeClient.submitPrompt({
      sessionKey,
      prompt: task.prompt || '',
    });
    this.taskBySession.set(sessionId, task.id);
    this.#touchSession(sessionId);
    this.#recordImmediateResponse(task, result?.text, 'claude-json');
    return {
      upstreamTaskId: sessionId,
      status: 'completed',
      raw: {
        transport: 'json',
        cliType: 'claude',
        sessionId,
        sessionKey,
        claudeSessionId: result?.sessionId || null,
      },
    };
  }

  async #submitOpenCodeTask(task) {
    if (!this.openCodeClient) {
      throw new Error('OpenCode client is not configured');
    }
    const sessionKey = task.metadata?.sessionKey || task.sessionKey || task.id;
    const sessionId = `opencode:${sessionKey}`;
    this.#ensureSessionCapacity(sessionId);
    task.localSessionId = sessionId;
    task.sessionKey = sessionKey;
    task.localTransport = 'opencode-run';
    this.#recordSessionMessage(task, {
      role: 'user',
      text: task.prompt || '',
      source: 'task-submit',
      finalize: true,
    });
    const model = String(task.metadata?.model || '').trim();
    const result = await this.openCodeClient.submitPrompt({
      sessionKey,
      prompt: task.prompt || '',
      model,
    });
    this.taskBySession.set(sessionId, task.id);
    this.#touchSession(sessionId);
    this.#recordImmediateResponse(task, result?.text, 'opencode-run');
    return {
      upstreamTaskId: sessionId,
      status: 'completed',
      raw: {
        transport: 'opencode-run',
        cliType: 'opencode',
        sessionId,
        sessionKey,
        opencodeSessionId: result?.sessionId || null,
      },
    };
  }

  getTask(taskId) {
    return this.tasks.get(taskId) || null;
  }

  getTaskByRunId(runId) {
    const needle = String(runId || '').trim();
    if (!needle) return null;
    for (const task of this.tasks.values()) {
      if (String(task?.runId || '') === needle) return task;
    }
    return null;
  }

  getTaskByThreadId(threadId) {
    const needle = String(threadId || '').trim();
    if (!needle) return null;
    for (const task of this.tasks.values()) {
      if (String(task?.metadata?.threadId || task?.threadId || '') === needle) return task;
    }
    return null;
  }

  getSessionActiveTask(sessionKey) {
    const normalized = this.#normalizeSessionKey(sessionKey);
    if (!normalized) return null;
    for (const task of this.tasks.values()) {
      if (!task) continue;
      if (!this.#isTaskActive(task)) continue;
      if (this.#normalizeSessionKey(task.sessionKey || task.metadata?.sessionKey || task.id) === normalized) {
        return task;
      }
    }
    return null;
  }

  listTasks() {
    return [...this.tasks.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  getSessionHistory(sessionId) {
    const task = this.#findTaskBySessionRef(sessionId);
    if (!task?.localSessionId) return null;
    return (this.sessionMessages.get(task.localSessionId) || []).map((message) => ({ ...message }));
  }

  async dispatchSessionMessage(sessionId, {
    message,
    target = 'openclaw',
    openclawMode = 'mirror',
    deliver = false,
  } = {}) {
    const task = this.#findTaskBySessionRef(sessionId);
    if (!task?.localSessionId) {
      throw new Error(`Unknown bridged session: ${sessionId}`);
    }
    const text = String(message || '').trim();
    if (!text) {
      throw new Error('Dispatch message is required');
    }

    const result = {
      sessionId: task.localSessionId,
      taskId: task.id,
      sessionKey: task.sessionKey || task.id,
      target,
    };

    if (target === 'local' || target === 'both') {
      result.local = await this.sendTaskInput(task.id, text, { source: 'manual-dispatch' });
    }

    if (target === 'openclaw' || target === 'both') {
      await this.#ensureOpenClawMirror(task);
      if (openclawMode === 'run') {
        result.openclaw = await this.client?.sendSessionMessage?.({
          sessionKey: task.sessionKey || task.id,
          message: text,
          deliver,
        });
      } else {
        this.#recordSessionMessage(task, {
          role: 'system',
          text,
          source: 'manual-dispatch',
          finalize: true,
          mirrorOverride: true,
        });
        result.openclaw = {
          ok: true,
          mode: 'mirror',
          sessionKey: task.sessionKey || task.id,
        };
      }
    }

    return result;
  }

  removeSession(sessionRef, { kill = true } = {}) {
    if (!sessionRef) return { removed: false, reason: 'missing_session_id' };
    const task = this.#findTaskBySessionRef(sessionRef);
    const resolvedSessionId = task?.localSessionId || String(sessionRef);

    if (task?.id) {
      this.taskBySession.delete(task.id);
      if (task.localSessionId) this.taskBySession.delete(task.localSessionId);
      if (task.structuredThreadId) this.taskBySession.delete(task.structuredThreadId);
      if (task.turnId) this.taskBySession.delete(task.turnId);
      const timer = this.assistantTurnTimers.get(task.id);
      if (timer) {
        clearTimeout(timer);
        this.assistantTurnTimers.delete(task.id);
      }
      task.activeAssistantMessageId = null;
    }

    this.sessions.delete(resolvedSessionId);
    this.boundSessions.delete(resolvedSessionId);
    this.sessionLastActive.delete(resolvedSessionId);
    this.sessionMessages.delete(resolvedSessionId);
    this.openClawMirrors.delete(resolvedSessionId);

    const removedFromLocal = Boolean(this.sessionManager?.get?.(resolvedSessionId));
    if (removedFromLocal) {
      this.sessionManager?.remove?.(resolvedSessionId, { kill });
    }

    return {
      removed: removedFromLocal || Boolean(task),
      sessionId: resolvedSessionId,
      taskId: task?.id || null,
    };
  }

  terminateTask(taskId, reason = 'manual') {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Unknown task: ${taskId}`);

    if (task.localSessionId) {
      if (task.structuredThreadId) {
        this.taskBySession.delete(task.structuredThreadId);
        this.taskBySession.delete(task.localSessionId);
      } else if (task.localTransport === 'claude-json') {
        this.taskBySession.delete(task.localSessionId);
      } else {
        this.sessionManager?.remove(task.localSessionId, { kill: true });
        this.sessions.delete(task.localSessionId);
        this.boundSessions.delete(task.localSessionId);
        this.sessionLastActive.delete(task.localSessionId);
      }
    }

    task.status = 'terminated';
    task.controlState = 'terminated';
    task.terminatedAt = Date.now();
    task.turnStatus = 'terminated';
    task.updatedAt = Date.now();
    task.terminateReason = reason;
    this.emit('task:terminated', task);
    this.emit('task:updated', task);
    return task;
  }

  pauseTask(taskId, reason = 'manual-pause') {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Unknown task: ${taskId}`);
    if (task.status === 'terminated' || task.status === 'failed' || task.status === 'completed') {
      const err = new Error(`Task ${taskId} is not pausable in status ${task.status}`);
      err.code = 'TASK_NOT_PAUSABLE';
      throw err;
    }
    task.controlState = 'paused';
    task.status = 'waiting_input';
    task.pauseReason = reason;
    task.pausedAt = Date.now();
    task.updatedAt = Date.now();
    this.emit('task:updated', task);
    return task;
  }

  async resumeTask(taskId, reason = 'manual-resume') {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Unknown task: ${taskId}`);
    if (task.controlState !== 'paused') {
      const err = new Error(`Task ${taskId} is not paused`);
      err.code = 'TASK_NOT_PAUSED';
      throw err;
    }
    task.controlState = 'running';
    task.resumeReason = reason;
    task.resumedAt = Date.now();
    task.status = 'submitted';
    task.updatedAt = Date.now();
    this.emit('task:updated', task);
    await this.#drainStructuredInputQueue(task);
    return task;
  }

  registerCallback(taskId, payload = {}) {
    if (!taskId) return null;
    const task = this.tasks.get(taskId);
    if (!task) return null;

    task.callbackCount = (task.callbackCount || 0) + 1;
    task.lastCallbackAt = Date.now();
    task.lastCallbackPayload = payload;

    if (task.status !== 'terminated' && task.status !== 'failed') {
      task.status = 'completed';
      task.completedAt = Date.now();
    }
    task.updatedAt = Date.now();
    this.emit('task:updated', task);
    return task;
  }

  getTaskStats() {
    const tasks = this.listTasks();
    const byStatus = {};
    for (const task of tasks) {
      const key = task.status || 'unknown';
      byStatus[key] = (byStatus[key] || 0) + 1;
    }

    return {
      total: tasks.length,
      byStatus,
      active: (byStatus.queued || 0) + (byStatus.submitted || 0),
      completed: byStatus.completed || 0,
      failed: byStatus.failed || 0,
      terminated: byStatus.terminated || 0,
      latestUpdatedAt: tasks[0]?.updatedAt || null,
    };
  }

  attachCallbackHandlers(session) {
    if (!session?.on) return;
    if (this.boundSessions.has(session.id)) return;
    this.boundSessions.add(session.id);
    session.on('output', (data) => {
      this.emit('session:output', { sessionId: session.id, data });
      this.#touchSession(session.id);
      const taskId = this.taskBySession.get(session.id);
      if (!taskId) return;
      const task = this.tasks.get(taskId);
      if (!task) return;
      const cleanData = this.#sanitizeOutput(data);
      if (!cleanData) return;
      task.callbackCount = (task.callbackCount || 0) + 1;
      task.lastCallbackAt = Date.now();
      task.outputBuffer = this.#appendOutput(task.outputBuffer, cleanData);
      task.answerText = this.#extractAnswerText(task.outputBuffer);
      task.lastCallbackPayload = {
        source: 'local-session',
        data: cleanData,
        extractedAnswer: task.answerText || '',
      };
      this.#upsertAssistantMessage(task, cleanData, {
        source: 'local-session',
        append: true,
        finalizeAfterMs: 1200,
      });
      task.turnStatus = 'inProgress';
      task.updatedAt = Date.now();
      this.emit('task:updated', task);
    });
    session.on('exit', () => {
      const taskId = this.taskBySession.get(session.id);
      const task = taskId ? this.tasks.get(taskId) : null;
      if (task) {
        this.#finalizeAssistantMessage(task);
      }
      this.emit('session:exit', { sessionId: session.id });
    });
  }

  compressContext(session) {
    this.emit('session:compressed', { sessionId: session.id, tokenCount: session.tokenCount });
  }

  requestFix(session, data) {
    this.emit('session:fix-requested', { sessionId: session.id, data });
  }

  recoverSession(session) {
    this.emit('session:recovered', { sessionId: session.id });
  }

  escalate(session, data) {
    this.emit('session:escalated', { sessionId: session.id, data });
  }

  onTaskComplete(session, data) {
    this.emit('task:complete', { sessionId: session.id, data });
  }

  async sendTaskInput(taskId, message, { source = 'task-input' } = {}) {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Unknown task: ${taskId}`);
    if (task.controlState === 'paused') {
      const err = new Error(`Task ${taskId} is paused`);
      err.code = 'TASK_PAUSED';
      throw err;
    }
    if (!task.localSessionId) {
      throw new Error(`Task ${taskId} is not backed by a local session`);
    }
    if (task.structuredThreadId) {
      this.taskBySession.set(task.structuredThreadId, task.id);
      this.taskBySession.set(task.localSessionId, task.id);
    } else {
      this.taskBySession.set(task.localSessionId, task.id);
    }
    this.#finalizeAssistantMessage(task);
    this.#recordSessionMessage(task, {
      role: 'user',
      text: message,
      source,
      finalize: true,
    });
    task.lastInputAt = Date.now();
    task.lastInput = message;
    task.updatedAt = Date.now();
    this.#touchSession(task.localSessionId);
    this.emit('task:updated', task);
    if (task.structuredThreadId) {
      const queue = Array.isArray(task.pendingStructuredInputs) ? task.pendingStructuredInputs : [];
      task.pendingStructuredInputs = queue;
      queue.push({ message, queuedAt: Date.now() });
      await this.#drainStructuredInputQueue(task);
    } else if (task.localTransport === 'claude-json') {
      const response = await this.claudeClient?.sendInput({
        sessionKey: task.sessionKey,
        message,
      });
      this.#recordImmediateResponse(task, response?.text, 'claude-json');
    } else if (task.localTransport === 'opencode-run') {
      const response = await this.openCodeClient?.sendInput({
        sessionKey: task.sessionKey,
        message,
      });
      this.#recordImmediateResponse(task, response?.text, 'opencode-run');
    } else {
      this.sessionManager?.send(task.localSessionId, message);
      task.status = 'submitted';
      task.completedAt = null;
      task.turnStatus = 'inProgress';
    }
    task.updatedAt = Date.now();
    this.emit('task:updated', task);
    return task;
  }

  async pollUpstreamTasks() {
    if (this.isPollingUpstream) return;
    if (!this.client?.getWsSessionSnapshots) return;
    const pending = [...this.tasks.values()].filter((task) => (
      String(task.sessionType || '').toLowerCase() === 'openclaw' &&
      task.status === 'submitted'
    ));
    if (pending.length === 0) return;
    this.isPollingUpstream = true;
    try {
      const snapshots = await this.client.getWsSessionSnapshots();
      if (!snapshots?.size) return;
      const now = Date.now();
      for (const task of pending) {
        const sessionKey = task.upstreamSessionKey || task.metadata?.sessionKey || task.id;
        const snapshot = snapshots.get(sessionKey);
        if (!snapshot) continue;
        const observedUpdatedAt = Number(snapshot.updatedAt || 0);
        if (observedUpdatedAt <= Number(task.upstreamObservedAt || 0)) continue;
        task.upstreamObservedAt = observedUpdatedAt;
        task.callbackCount = (task.callbackCount || 0) + 1;
        task.lastCallbackAt = now;
        task.lastCallbackPayload = {
          source: 'openclaw-status-poll',
          data: snapshot,
        };
        const aborted = Boolean(snapshot.abortedLastRun);
        const outputTokens = Number(snapshot.outputTokens || 0);
        const systemSent = Boolean(snapshot.systemSent);
        if (aborted) {
          task.status = 'failed';
          task.turnStatus = 'failed';
          task.error = 'OpenClaw upstream session reported abortedLastRun=true';
          task.completedAt = now;
        } else if (outputTokens > 0 && observedUpdatedAt >= Number(task.submittedAt || 0)) {
          task.status = 'completed';
          task.turnStatus = 'completed';
          task.completedAt = now;
          if (!task.answerText) {
            task.answerText = `OpenClaw run completed (runId=${task.upstreamRunId || task.upstreamTaskId || 'unknown'})`;
          }
        } else if (systemSent && observedUpdatedAt >= Number(task.submittedAt || 0)) {
          task.status = 'completed';
          task.turnStatus = 'completed';
          task.completedAt = now;
          if (!task.answerText) {
            task.answerText = `OpenClaw run completed (runId=${task.upstreamRunId || task.upstreamTaskId || 'unknown'})`;
          }
        }
        task.updatedAt = now;
        this.emit('task:updated', task);
        this.emit('session:output', {
          sessionId: task.upstreamTaskId || task.id,
          data: JSON.stringify({ source: 'openclaw-status-poll', snapshot }),
        });
      }
    } finally {
      this.isPollingUpstream = false;
    }
  }

  async pollInboundBridge() {
    if (this.isPollingInboundBridge) return;
    if (!this.client?.getSessionHistory) return;
    const bridged = [...this.tasks.values()].filter((task) => this.#shouldBridgeOpenClaw(task) && task.localSessionId);
    if (bridged.length === 0) return;
    this.isPollingInboundBridge = true;
    try {
      for (const task of bridged) {
        await this.#pollTaskInboundBridge(task);
      }
    } finally {
      this.isPollingInboundBridge = false;
    }
  }

  sweep(now = Date.now()) {
    this.#cleanupExpiredTasks(now);
    this.#cleanupIdleSessions(now);
  }

  #ensureTaskCapacity() {
    if (this.tasks.size < this.maxTasks) return;
    if (this.overflowPolicy === 'reject') {
      throw new Error(`Task capacity reached (max=${this.maxTasks})`);
    }
    const evicted = this.#evictOldestTasks(1);
    if (evicted < 1) {
      throw new Error(`Task capacity reached and no evictable task found (max=${this.maxTasks})`);
    }
  }

  #ensureSessionCapacity(targetSessionId) {
    const sessions = this.#listSessionIds();
    if (sessions.includes(targetSessionId)) return;
    if (sessions.length < this.maxSessions) return;
    if (this.overflowPolicy === 'reject') {
      throw new Error(`Session capacity reached (max=${this.maxSessions})`);
    }
    const evicted = this.#evictOldestSessions(1, Date.now());
    if (evicted < 1) {
      throw new Error(`Session capacity reached and no evictable session found (max=${this.maxSessions})`);
    }
  }

  #evictOldestTasks(count) {
    const candidates = [...this.tasks.values()]
      .filter((task) => ['completed', 'failed', 'terminated'].includes(task.status))
      .sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0))
      .slice(0, count);
    for (const task of candidates) {
      this.#removeTask(task.id, 'capacity-evict');
    }
    return candidates.length;
  }

  #evictOldestSessions(count, now = Date.now()) {
    const candidates = this.#listSessionIds()
      .filter((id) => this.#isSessionEvictable(id))
      .map((id) => ({ id, ts: this.sessionLastActive.get(id) || now }))
      .sort((a, b) => a.ts - b.ts)
      .slice(0, count);
    for (const candidate of candidates) {
      this.#removeSession(candidate.id, 'capacity-evict');
    }
    return candidates.length;
  }

  #cleanupExpiredTasks(now) {
    for (const task of this.tasks.values()) {
      // 中断超时：waiting_input 超过 interruptTtlMs 自动终止
      if (task.status === 'waiting_input' && task.pausedAt) {
        if (now - task.pausedAt >= this.interruptTtlMs) {
          task.status = 'terminated';
          task.controlState = 'terminated';
          task.terminatedAt = now;
          task.updatedAt = now;
          this.logger.info?.(`[sweep] task ${task.id} terminated: interrupt-timeout`);
          this.emit('task:terminated', task.id, 'interrupt-timeout');
        }
      }

      // completed/failed 超过 15min → 转为 terminated，裁剪大字段
      if (['completed', 'failed'].includes(task.status)) {
        const finishedAt = task.completedAt || task.updatedAt || task.createdAt || now;
        if (now - finishedAt >= this.taskRetentionMs) {
          task.status = 'terminated';
          task.controlState = 'terminated';
          task.terminatedAt = now;
          task.updatedAt = now;
          // 裁剪大字段，只保留摘要
          task.outputBuffer = '';
          task.lastCallbackPayload = null;
          task.lastSubmitResult = null;
          this.emit('task:terminated', task.id, 'retention-expired');
        }
      }

      // terminated 超过 5h → 从内存删除
      if (task.status === 'terminated') {
        const terminatedAt = task.terminatedAt || task.updatedAt || task.createdAt || now;
        if (now - terminatedAt >= this.terminatedRetentionMs) {
          this.#removeTask(task.id, 'retention-expired');
        }
      }
    }
  }

  #cleanupIdleSessions(now) {
    for (const sessionId of this.#listSessionIds()) {
      const ts = this.sessionLastActive.get(sessionId) || now;
      if (now - ts < this.sessionIdleTtlMs) continue;
      if (!this.#isSessionEvictable(sessionId)) continue;
      this.#removeSession(sessionId, 'idle-ttl');
    }
  }

  #isSessionEvictable(sessionId) {
    const taskId = this.taskBySession.get(sessionId);
    if (!taskId) return true;
    const task = this.tasks.get(taskId);
    if (!task) return true;
    return !['queued', 'submitted'].includes(task.status);
  }

  #removeTask(taskId, reason) {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    if (task.structuredThreadId && this.taskBySession.get(task.structuredThreadId) === taskId) {
      this.taskBySession.delete(task.structuredThreadId);
    }
    if (task.localSessionId && this.taskBySession.get(task.localSessionId) === taskId) {
      this.taskBySession.delete(task.localSessionId);
    }
    this.tasks.delete(taskId);
    this.emit('task:evicted', { taskId, reason });
    return true;
  }

  dismissTask(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Unknown task: ${taskId}`);
    if (!['completed', 'failed', 'terminated'].includes(task.status)) {
      throw new Error(`Task ${taskId} is still active (status=${task.status}); terminate it first`);
    }
    this.#removeTask(taskId, 'dismissed');
  }

  #removeSession(sessionId, reason) {
    if (sessionId.startsWith('codex:')) {
      this.codexClient?.forgetSession?.(sessionId);
    } else if (sessionId.startsWith('claude:')) {
      this.claudeClient?.forgetSession?.(sessionId);
    } else {
      this.sessionManager?.remove?.(sessionId, { kill: true });
      this.sessions.delete(sessionId);
    }
    this.taskBySession.delete(sessionId);
    this.boundSessions.delete(sessionId);
    this.sessionLastActive.delete(sessionId);
    this.sessionMessages.delete(sessionId);
    this.emit('session:evicted', { sessionId, reason });
  }

  #touchSession(sessionId, now = Date.now()) {
    if (!sessionId) return;
    this.sessionLastActive.set(sessionId, now);
  }

  #listSessionIds() {
    const ids = new Set();
    for (const session of this.sessionManager?.list?.() || []) {
      ids.add(session.id);
    }
    for (const session of this.codexClient?.listSessions?.() || []) {
      ids.add(session.id);
    }
    for (const session of this.claudeClient?.listSessions?.() || []) {
      ids.add(session.id);
    }
    return [...ids];
  }

  #findTaskBySessionRef(sessionRef) {
    if (!sessionRef) return null;
    if (this.tasks.has(sessionRef)) {
      return this.tasks.get(sessionRef) || null;
    }
    for (const task of this.tasks.values()) {
      if (!task) continue;
      if (task.localSessionId === sessionRef || task.sessionKey === sessionRef || task.id === sessionRef) {
        return task;
      }
    }
    return null;
  }

  #getSessionMessages(sessionId) {
    if (!this.sessionMessages.has(sessionId)) {
      this.sessionMessages.set(sessionId, []);
    }
    return this.sessionMessages.get(sessionId);
  }

  #emitSessionMessage(sessionId, message, update = false) {
    this.emit('session:message', {
      sessionId,
      message: { ...message },
      update,
      historyCount: (this.sessionMessages.get(sessionId) || []).length,
    });
  }

  #recordSessionMessage(task, {
    role,
    text,
    source,
    finalize = true,
    mirrorOverride = false,
    turnId = null,
  }) {
    if (!task?.localSessionId) return null;
    const cleanText = String(text || '').trim();
    if (!cleanText) return null;
    const sessionId = task.localSessionId;
    const message = {
      id: randomUUID(),
      role,
      text: cleanText,
      source,
      turnId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: finalize ? 'completed' : 'streaming',
      mirroredAt: null,
      mirrorError: null,
    };
    this.#getSessionMessages(sessionId).push(message);
    this.#emitSessionMessage(sessionId, message);
    if ((mirrorOverride || finalize) && this.#shouldMirrorSessionMessage(task, message, { mirrorOverride })) {
      this.#mirrorSessionMessage(task, message).catch((error) => {
        message.mirrorError = error.message;
        message.updatedAt = Date.now();
        this.#emitSessionMessage(sessionId, message, true);
      });
    }
    return message;
  }

  #upsertAssistantMessage(task, text, {
    source = 'local-session',
    turnId = null,
    append = false,
    replace = false,
    finalizeAfterMs = 0,
  } = {}) {
    if (!task?.localSessionId) return null;
    const cleanText = String(text || '').trim();
    if (!cleanText) return null;
    const sessionId = task.localSessionId;
    const messages = this.#getSessionMessages(sessionId);
    let message = messages.find((item) => item.id === task.activeAssistantMessageId) || null;
    if (!message) {
      message = {
        id: randomUUID(),
        role: 'assistant',
        text: cleanText,
        source,
        turnId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        status: 'streaming',
        mirroredAt: null,
        mirrorError: null,
      };
      messages.push(message);
      task.activeAssistantMessageId = message.id;
      this.#emitSessionMessage(sessionId, message);
    } else {
      const nextText = replace
        ? cleanText
        : append
          ? this.#appendHistoryText(message.text, cleanText)
          : cleanText;
      if (nextText === message.text && message.status === 'streaming') {
        if (finalizeAfterMs > 0) {
          this.#scheduleAssistantFinalize(task, finalizeAfterMs);
        }
        return message;
      }
      message.text = nextText;
      message.source = source;
      message.turnId = turnId || message.turnId || null;
      message.updatedAt = Date.now();
      message.status = 'streaming';
      this.#emitSessionMessage(sessionId, message, true);
    }
    if (finalizeAfterMs > 0) {
      this.#scheduleAssistantFinalize(task, finalizeAfterMs);
    }
    return message;
  }

  #scheduleAssistantFinalize(task, delayMs) {
    const existing = this.assistantTurnTimers.get(task.id);
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      this.assistantTurnTimers.delete(task.id);
      this.#finalizeAssistantMessage(task);
    }, delayMs);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    this.assistantTurnTimers.set(task.id, timer);
  }

  #finalizeAssistantMessage(task) {
    if (!task?.localSessionId || !task.activeAssistantMessageId) return;
    const timer = this.assistantTurnTimers.get(task.id);
    if (timer) {
      clearTimeout(timer);
      this.assistantTurnTimers.delete(task.id);
    }
    const messages = this.sessionMessages.get(task.localSessionId) || [];
    const message = messages.find((item) => item.id === task.activeAssistantMessageId);
    task.activeAssistantMessageId = null;
    if (!message) return;
    message.status = 'completed';
    message.updatedAt = Date.now();
    this.#emitSessionMessage(task.localSessionId, message, true);
    if (this.#shouldBridgeOpenClaw(task) && !message.mirroredAt) {
      this.#mirrorSessionMessage(task, message).catch((error) => {
        message.mirrorError = error.message;
        message.updatedAt = Date.now();
        this.#emitSessionMessage(task.localSessionId, message, true);
      });
    }
  }

  #shouldBridgeOpenClaw(task) {
    const sessionType = String(task?.sessionType || '').toLowerCase();
    if (!['codex', 'claude', 'gemini'].includes(sessionType)) return false;
    if (task?.metadata?.bridgeOpenClaw === false) return false;
    const explicitEnabled = task?.metadata?.bridgeOpenClaw === true;
    const fromBridgeChannel = String(task?.metadata?.source || '').toLowerCase() === 'openclaw-channel';
    if (!explicitEnabled && !fromBridgeChannel) return false;
    return Boolean(this.client?.ensureSession && this.client?.injectSessionMessage);
  }

  #shouldMirrorSessionMessage(task, message, { mirrorOverride = false } = {}) {
    if (mirrorOverride) return this.#shouldBridgeOpenClaw(task);
    if (!this.#shouldBridgeOpenClaw(task)) return false;
    // OpenClaw already renders the original user turn in the UI. Re-injecting the
    // same user message as [bridge:user] makes it appear duplicated.
    if (message?.role === 'user' && message?.source === 'openclaw-ui') {
      return false;
    }
    return true;
  }

  async #pollTaskInboundBridge(task) {
    const sessionKey = task.sessionKey || task.id;
    if (!sessionKey) return;
    const transcript = await this.client.getSessionHistory({
      sessionKey,
      limit: 50,
    }).catch((error) => {
      task.bridgeError = error.message;
      task.updatedAt = Date.now();
      this.emit('task:updated', task);
      return null;
    });
    if (!transcript?.messages?.length) return;
    const messages = Array.isArray(transcript.messages) ? transcript.messages : [];
    let newestSeq = Number(task.lastInboundSeq || 0);
    const inbound = [];
    for (const message of messages) {
      const seq = Number(message?.__openclaw?.seq || message?.seq || 0);
      if (String(message?.role || '').toLowerCase() !== 'user') continue;
      const text = this.#extractOpenClawMessageText(message);
      if (!text) continue;
      const fingerprint = this.#buildInboundFingerprint(message, text);
      if (this.#isDuplicateInboundMessage(task, seq, fingerprint, text)) continue;
      if (Number.isFinite(seq) && seq > 0) {
        newestSeq = Math.max(newestSeq, seq);
      }
      inbound.push({ seq, text, fingerprint });
    }
    if (newestSeq > Number(task.lastInboundSeq || 0)) {
      task.lastInboundSeq = newestSeq;
      task.updatedAt = Date.now();
      this.emit('task:updated', task);
    }
    if (inbound.length === 0) return;
    for (const entry of inbound.sort((a, b) => a.seq - b.seq)) {
      task.lastInboundFingerprint = entry.fingerprint;
      task.lastInboundText = entry.text;
      if (Number.isFinite(entry.seq) && entry.seq > Number(task.lastInboundSeq || 0)) {
        task.lastInboundSeq = entry.seq;
      }
      await this.sendTaskInput(task.id, entry.text, { source: 'openclaw-ui' });
    }
    task.lastInboundAt = Date.now();
    task.updatedAt = Date.now();
    this.emit('task:updated', task);
    await this.client.abortSession?.({ sessionKey }).catch(() => {});
  }

  async #ensureOpenClawMirror(task) {
    const sessionKey = task?.sessionKey || task?.metadata?.sessionKey || task?.id;
    if (!sessionKey || this.openClawMirrors.has(sessionKey)) return;
    await this.client.ensureSession({
      sessionKey,
      label: `CLI Bridge / ${String(task?.sessionType || 'cli')} / ${sessionKey}`,
    });
    this.openClawMirrors.add(sessionKey);
    await this.gatewaySubscriber?.subscribeSession?.(sessionKey).catch((error) => {
      this.logger?.warn?.(`OpenClaw subscribe failed for ${sessionKey}: ${error.message}`);
    });
  }

  async #mirrorSessionMessage(task, message) {
    const sessionKey = task.sessionKey || task.id;
    await this.#enqueueMirrorOperation(sessionKey, async () => {
      await this.#ensureOpenClawMirror(task);
      await this.client.injectSessionMessage({
        sessionKey,
        label: `bridge:${message.role}`,
        message: this.#formatMirrorMessage(task, message),
      });
      message.mirroredAt = Date.now();
      message.mirrorError = null;
      message.updatedAt = Date.now();
      this.#emitSessionMessage(task.localSessionId, message, true);
    });
  }

  #formatMirrorMessage(task, message) {
    const cliLabel = String(task?.sessionType || 'cli').toUpperCase();
    if (message.role === 'user') {
      return `[USER -> ${cliLabel}]\n${message.text}`;
    }
    if (message.role === 'system') {
      return `[DISPATCH]\n${message.text}`;
    }
    return `[${cliLabel}]\n${message.text}`;
  }

  #extractOpenClawMessageText(message) {
    if (typeof message?.content === 'string') {
      return this.#normalizeInboundUserText(message.content.trim());
    }
    if (!Array.isArray(message?.content)) return '';
    return this.#normalizeInboundUserText(message.content
      .map((item) => (typeof item?.text === 'string' ? item.text : ''))
      .join('')
      .trim());
  }

  async #handleGatewaySessionMessage(payload) {
    const sessionRef = this.#normalizeBridgedSessionRef(payload?.sessionKey);
    if (!sessionRef) return;
    const task = this.#findTaskBySessionRef(sessionRef);
    if (!task?.localSessionId || !this.#shouldBridgeOpenClaw(task)) return;
    const message = payload?.message || {};
    if (String(message.role || '').toLowerCase() !== 'user') return;
    const seq = Number(payload?.messageSeq ?? message?.__openclaw?.seq ?? 0);
    const text = this.#extractOpenClawMessageText(message);
    if (!text) return;
    const fingerprint = this.#buildInboundFingerprint(message, text, payload);
    if (this.#isDuplicateInboundMessage(task, seq, fingerprint, text)) return;
    task.lastInboundFingerprint = fingerprint;
    task.lastInboundText = text;
    if (Number.isFinite(seq) && seq > Number(task.lastInboundSeq || 0)) {
      task.lastInboundSeq = seq;
    }
    task.lastInboundAt = Date.now();
    task.updatedAt = Date.now();
    this.emit('task:updated', task);
    await this.sendTaskInput(task.id, text, { source: 'openclaw-ui' });
    await this.client.abortSession?.({ sessionKey: task.sessionKey || task.id }).catch(() => {});
  }

  #normalizeBridgedSessionRef(raw) {
    const text = String(raw || '').trim();
    if (!text) return '';
    const parts = text.split(':').filter(Boolean);
    return parts.at(-1) || text;
  }

  #normalizeSessionKey(raw) {
    return this.#normalizeBridgedSessionRef(raw);
  }

  #buildInboundFingerprint(message, text) {
    const role = String(message?.role || '').toLowerCase();
    const seq = Number(message?.__openclaw?.seq ?? message?.seq ?? 0);
    const messageId = String(message?.__openclaw?.id || message?.id || '').trim();
    const timestamp = Number(message?.timestamp || message?.createdAt || 0);
    if (messageId) {
      return `${role}:id:${messageId}:${text}`;
    }
    if (Number.isFinite(seq) && seq > 0) {
      return `${role}:seq:${seq}:${text}`;
    }
    if (Number.isFinite(timestamp) && timestamp > 0) {
      return `${role}:ts:${timestamp}:${text}`;
    }
    return `${role}:text:${text}`;
  }

  #isDuplicateInboundMessage(task, seq, fingerprint, text = '') {
    if (fingerprint && task.lastInboundFingerprint === fingerprint) {
      return true;
    }
    if (Number.isFinite(seq) && seq > 0 && seq <= Number(task.lastInboundSeq || 0)) {
      return true;
    }
    // For seq=0 messages, suppress immediate duplicate relays from ws + history poll.
    if (
      String(fingerprint || '').includes(':text:')
      && task.lastInboundText
      && task.lastInboundText === text
      && (Date.now() - Number(task.lastInboundAt || 0)) < 10_000
    ) {
      return true;
    }
    return false;
  }

  #normalizeInboundUserText(text) {
    const value = String(text || '').trim();
    if (!value) return '';
    if (/^\[bridge:(user|assistant|system)\]/i.test(value)) {
      return '';
    }
    if (/^Sender \(untrusted metadata\):/i.test(value)) {
      const normalized = value.replace(/^Sender \(untrusted metadata\):\s*/i, '').trim();
      if (!normalized) return '';
      if (/^\[bridge:(user|assistant|system)\]/i.test(normalized)) return '';
      return normalized;
    }
    return value;
  }

  #appendHistoryText(previous, chunk) {
    const prior = String(previous || '').trim();
    const next = String(chunk || '').trim();
    if (!prior) return next;
    if (!next) return prior;
    if (prior === next) return prior;
    if (next.startsWith(prior)) return next;
    return `${prior}\n${next}`.trim();
  }

  #recordImmediateResponse(task, text, source = 'local-session') {
    const cleanData = this.#sanitizeOutput(text || '');
    if (!cleanData) {
      task.localTransport = source === 'claude-json' ? 'claude-json' : task.localTransport || 'local-cli';
      task.turnStatus = 'failed';
      task.status = 'failed';
      task.error = `Empty assistant output from ${source}`;
      task.completedAt = Date.now();
      return;
    }
    task.callbackCount = (task.callbackCount || 0) + 1;
    task.lastCallbackAt = Date.now();
    task.outputBuffer = this.#appendOutput(task.outputBuffer, cleanData);
    task.answerText = this.#extractAnswerText(task.outputBuffer);
    task.lastCallbackPayload = {
      source,
      data: cleanData,
      extractedAnswer: task.answerText || '',
    };
    task.localTransport = source === 'claude-json' ? 'claude-json' : task.localTransport || 'local-cli';
    task.turnStatus = 'completed';
    task.status = 'completed';
    task.completedAt = Date.now();
    this.#touchSession(task.localSessionId);
    this.#recordSessionMessage(task, {
      role: 'assistant',
      text: cleanData,
      source,
      finalize: true,
      turnId: task.turnId || null,
    });
  }

  #appendOutput(previous, chunk) {
    const merged = `${previous || ''}\n${chunk || ''}`.trim();
    return this.#truncateOutputBuffer(merged);
  }

  async #enqueueMirrorOperation(sessionKey, operation) {
    const key = String(sessionKey || '').trim();
    if (!key) {
      await operation();
      return;
    }
    const prior = this.openClawMirrorChains.get(key) || Promise.resolve();
    const next = prior
      .catch(() => {})
      .then(operation);
    this.openClawMirrorChains.set(key, next);
    try {
      await next;
    } finally {
      if (this.openClawMirrorChains.get(key) === next) {
        this.openClawMirrorChains.delete(key);
      }
    }
  }

  async #drainStructuredInputQueue(task) {
    if (!task?.structuredThreadId) return;
    if (task.isDrainingStructuredInputs) return;
    if (String(task.turnStatus || '').toLowerCase() === 'inprogress') return;
    const queue = Array.isArray(task.pendingStructuredInputs) ? task.pendingStructuredInputs : [];
    if (queue.length === 0) return;

    task.isDrainingStructuredInputs = true;
    try {
      while (queue.length > 0 && String(task.turnStatus || '').toLowerCase() !== 'inprogress') {
        const next = queue.shift();
        if (!next?.message) continue;
        this.#commitStructuredTurnOutput(task);
        const response = await this.codexClient?.sendInput({
          sessionKey: task.sessionKey,
          threadId: task.structuredThreadId,
          message: next.message,
          model: String(task.metadata?.model || '').trim(),
        });
        task.turnId = response?.turnId || task.turnId || null;
        task.status = 'submitted';
        task.completedAt = null;
        task.turnStatus = 'inProgress';
        task.updatedAt = Date.now();
        this.emit('task:updated', task);
      }
    } finally {
      task.isDrainingStructuredInputs = false;
    }
  }

  #normalizeStructuredDelta(data) {
    return String(data || '').replace(/\r/g, '');
  }

  #mergeStructuredTurnText(previous, next) {
    const prior = this.#normalizeStructuredDelta(previous);
    const current = this.#normalizeStructuredDelta(next);
    if (!current.trim()) return prior;
    if (!prior) return current;
    if (current.startsWith(prior)) return current;
    if (prior.startsWith(current)) return prior;
    return `${prior}${current}`;
  }

  #combineStructuredOutput(task) {
    const currentTurn = String(task?.structuredTurnText || '').trim();
    if (!currentTurn) {
      return String(task?.outputBuffer || '').trim();
    }
    return this.#appendOutput(task?.outputBuffer || '', currentTurn);
  }

  #commitStructuredTurnOutput(task) {
    const currentTurn = String(task?.structuredTurnText || '').trim();
    if (!currentTurn) return;
    task.outputBuffer = this.#appendOutput(task.outputBuffer, currentTurn);
    task.structuredTurnText = '';
  }

  #truncateOutputBuffer(text) {
    if (Buffer.byteLength(text, 'utf8') <= this.outputBufferMaxBytes) {
      return text;
    }
    const lines = text.split('\n');
    while (lines.length > 1 && Buffer.byteLength(lines.join('\n'), 'utf8') > this.outputBufferMaxBytes) {
      lines.shift();
    }
    const joined = lines.join('\n');
    if (Buffer.byteLength(joined, 'utf8') <= this.outputBufferMaxBytes) {
      return joined;
    }
    const buffer = Buffer.from(joined, 'utf8');
    return buffer.subarray(buffer.length - this.outputBufferMaxBytes).toString('utf8');
  }

  #sanitizeOutput(data) {
    const text = String(data || '')
      .replace(ANSI_PATTERN, ' ')
      .replace(CONTROL_PATTERN, ' ')
      .replace(/\r/g, '\n');
    const lines = text
      .split('\n')
      .map((line) => line.replace(/^✦\s*/, '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .filter((line) => !/[╭╰│─┌┐└┘▀▄▝▜▗▟]{3,}/.test(line))
      .filter((line) => !UI_NOISE_PATTERNS.some((pattern) => pattern.test(line)));
    return lines.join('\n').trim();
  }

  #extractAnswerText(buffer) {
    const text = String(buffer || '').trim();
    if (!text) return '';
    const lines = text
      .split('\n')
      .map((line) => line.replace(/^✦\s*/, '').trim())
      .filter(Boolean)
      .filter((line) => !/[╭╰│─┌┐└┘▀▄▝▜▗▟]{3,}/.test(line))
      .filter((line) => !UI_NOISE_PATTERNS.some((pattern) => pattern.test(line)))
      .filter((line) => !/cannot be used with root\/sudo privileges/i.test(line));
    return lines.slice(-6).join('\n').trim();
  }

  #finalizeLocalTask(task) {
    this.#finalizeAssistantMessage(task);
    task.answerText = this.#extractAnswerText(task.outputBuffer || task.lastCallbackPayload?.data || '');
    if (task.lastCallbackPayload?.source === 'local-session') {
      task.lastCallbackPayload = {
        ...task.lastCallbackPayload,
        extractedAnswer: task.answerText || '',
      };
    }
    task.turnStatus = 'completed';
  }

  #isTaskActive(task) {
    const state = String(task?.status || '').toLowerCase();
    return ['submitted', 'running', 'waiting_input'].includes(state);
  }

  #assertSessionAvailability(task) {
    if (task?.metadata?.allowParallelInSession === true) return;
    const sessionKey = this.#normalizeSessionKey(task?.sessionKey || task?.metadata?.sessionKey || task?.id);
    if (!sessionKey) return;
    for (const other of this.tasks.values()) {
      if (!other || other.id === task.id) continue;
      if (other?.metadata?.allowParallelInSession === true) continue;
      const otherKey = this.#normalizeSessionKey(other.sessionKey || other.metadata?.sessionKey || other.id);
      if (otherKey !== sessionKey) continue;
      if (!this.#isTaskActive(other)) continue;
      const err = new Error(`Session ${sessionKey} already has active task ${other.id}`);
      err.code = 'SESSION_BUSY';
      err.conflictTaskId = other.id;
      throw err;
    }
  }

  #emitRunEvent(type, task, overrides = {}) {
    if (!task) return;
    const payload = {
      type,
      runId: task.runId || `run:${task.id}`,
      taskId: task.id,
      sessionKey: task.sessionKey || task.metadata?.sessionKey || task.id,
      agentId: task.agentId || task.metadata?.agentId || null,
      threadId: task.threadId || task.metadata?.threadId || null,
      attempt: Number(task.attempt || task.metadata?.attempt || 1),
      controlState: task.controlState || 'running',
      runtime: String(task.sessionType || '').toLowerCase() || 'openclaw',
      status: this.#statusToRunStatus(task.status),
      ts: Date.now(),
      source: overrides.source || 'backend',
      message: overrides.message || '',
    };
    this.emit('run:event', payload);
  }

  #statusToRunStatus(status) {
    const value = String(status || '').toLowerCase();
    if (value === 'queued') return 'idle';
    if (value === 'submitted') return 'running';
    if (value === 'completed') return 'completed';
    if (value === 'failed') return 'failed';
    if (value === 'terminated') return 'terminated';
    return value || 'unknown';
  }
}
