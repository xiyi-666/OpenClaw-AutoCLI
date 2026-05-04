import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import { ClaudeJsonClient } from './claude/ClaudeJsonClient.js';
import { GeminiPromptClient } from './gemini/GeminiPromptClient.js';
import { OpenCodeRunClient } from './opencode/OpenCodeRunClient.js';
import { CodexStructuredClient } from './codex/CodexStructuredClient.js';
import { AcpxClient } from './acpx/AcpxClient.js';
import { OpenClawClient } from './openclaw/OpenClawClient.js';
import { OpenClawGatewaySubscriber } from './openclaw/OpenClawGatewaySubscriber.js';
import { TaskOrchestrator } from './orchestrator/TaskOrchestrator.js';
import { Probe } from './probe/Probe.js';
import { SessionManager } from './session/SessionManager.js';

function sanitizeWorkspaceName(name) {
  return String(name || '')
    .trim()
    .replace(/[\\/]+/g, '-')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '') || 'session';
}

function createWorkspaceCwd({ sessionId, cliType, cwd, workspaceRoot }) {
  if (cwd) {
    const resolvedCwd = isAbsolute(cwd) ? cwd : resolve(process.cwd(), cwd);
    mkdirSync(resolvedCwd, { recursive: true });
    return resolvedCwd;
  }
  const root = workspaceRoot || resolve(process.cwd(), '.workspaces');
  const safeCli = sanitizeWorkspaceName(cliType || 'session');
  const safeSession = sanitizeWorkspaceName(sessionId || 'session');
  const resolved = resolve(root, safeCli, safeSession);
  mkdirSync(resolved, { recursive: true });
  return resolved;
}

export function createRuntime({
  client = (() => {
    const mode = String(process.env.OPENCLAW_CLIENT_MODE || 'acpx').trim().toLowerCase();
    if (mode === 'openclaw') {
      return new OpenClawClient({
        baseUrl: process.env.OPENCLAW_BASE_URL || 'http://127.0.0.1:18789',
        submitPath: process.env.OPENCLAW_SUBMIT_PATH || '/api/tasks',
        callbackPath: process.env.OPENCLAW_CALLBACK_PATH || '/callbacks/openclaw',
        apiKey: process.env.OPENCLAW_GATEWAY_TOKEN || process.env.OPENCLAW_API_KEY || '',
        timeoutMs: Number(process.env.OPENCLAW_TIMEOUT_MS || 15000),
        transport: process.env.OPENCLAW_TRANSPORT || 'ws',
      });
    }
    return new AcpxClient({
      baseUrl: process.env.OPENCLAW_ACPX_BASE_URL || process.env.OPENCLAW_BASE_URL || 'http://127.0.0.1:18789',
      apiKey: process.env.OPENCLAW_ACPX_API_KEY || process.env.OPENCLAW_GATEWAY_TOKEN || process.env.OPENCLAW_API_KEY || '',
      timeoutMs: Number(process.env.OPENCLAW_ACPX_TIMEOUT_MS || process.env.OPENCLAW_TIMEOUT_MS || 15000),
    });
  })(),
  sessionManager = new SessionManager(),
  codexClient = new CodexStructuredClient(),
  claudeClient = new ClaudeJsonClient(),
  geminiClient = new GeminiPromptClient(),
  openCodeClient = new OpenCodeRunClient(),
  gatewaySubscriber = new OpenClawGatewaySubscriber(),
  orchestrator = null,
  workspaceRoot = process.env.OPENCLAW_WORKSPACE_ROOT || resolve(process.cwd(), '.workspaces'),
} = {}) {
  const runtimeOrchestrator = orchestrator || new TaskOrchestrator({
    client,
    sessionManager,
    codexClient,
    claudeClient,
    openCodeClient,
    gatewaySubscriber,
  });

  mkdirSync(workspaceRoot, { recursive: true });

  sessionManager.on?.('session:created', (session) => {
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
    geminiClient,
    openCodeClient,
    gatewaySubscriber,
    orchestrator: runtimeOrchestrator,
  };
}

export function createAppServer({
  client,
  sessionManager,
  codexClient,
  claudeClient,
  geminiClient,
  openCodeClient,
  orchestrator,
  workspaceRoot = resolve(process.cwd(), '.workspaces'),
}) {
  const softTimeoutMs = Math.max(0, Number(process.env.OPENCLAW_HTTP_SOFT_TIMEOUT_MS || 60000));
  const bridgeMaxRetry = Math.max(0, Number(process.env.OPENCLAW_BRIDGE_MAX_RETRY || 3));
  const bridgeThreads = new Map();
  const structuredCodexSessions = new Map();
  const structuredCodexThreadToSession = new Map();
  const structuredCodexStateBySession = new Map();
  const structuredCodexModelBySession = new Map();
  const acpxSessions = new Map();
  const acpxSessionHistory = new Map();
  const acpxSessionsByKey = new Map();
  const acpxLocalOutputBuffer = new Map();
  const acpxLocalOutputCursor = new Map();
  const openClawSessionBindings = new Map();
  const frontendSessions = new Map();
  const gatewayToken = String(process.env.OPENCLAW_GATEWAY_TOKEN || process.env.OPENCLAW_API_KEY || '').trim();
  const authorizeBridgeRequest = (req) => {
    if (!gatewayToken) return true;
    const authHeader = String(req.headers.authorization || '').trim();
    const bearerToken = authHeader.toLowerCase().startsWith('bearer ')
      ? authHeader.slice('bearer '.length).trim()
      : '';
    const headerToken = String(req.headers['x-openclaw-token'] || req.headers['x-gateway-token'] || '').trim();
    return bearerToken === gatewayToken || headerToken === gatewayToken;
  };

  const toCodexSessionKey = (id) => {
    const text = String(id || '').trim();
    if (!text) return '';
    return text.startsWith('codex:') ? text.slice('codex:'.length) : text;
  };
  const toCodexSessionId = (id) => {
    const key = toCodexSessionKey(id);
    return key ? `codex:${key}` : '';
  };

  const mergeStructuredText = (prev, next) => {
    const left = String(prev || '');
    const right = String(next || '');
    if (!right) return left;
    if (!left) return right;
    if (right.startsWith(left)) return right;
    if (left.endsWith(right)) return left;
    return `${left}${right}`;
  };
  const pickStructuredText = (input) => {
    if (typeof input === 'string') return input;
    if (typeof input === 'number' || typeof input === 'boolean') return String(input);
    if (Array.isArray(input)) return input.map((item) => pickStructuredText(item)).join('');
    if (!input || typeof input !== 'object') return '';
    if (typeof input.text === 'string') return input.text;
    if (typeof input.content === 'string') return input.content;
    if (Array.isArray(input.content)) return pickStructuredText(input.content);
    if (typeof input.delta === 'string') return input.delta;
    if (typeof input.value === 'string') return input.value;
    return '';
  };

  const getStructuredSessionState = (sessionId) => {
    if (!structuredCodexStateBySession.has(sessionId)) {
      structuredCodexStateBySession.set(sessionId, {
        activeAssistantMessageId: null,
        activeTurnId: null,
        activeText: '',
        history: [],
      });
    }
    return structuredCodexStateBySession.get(sessionId);
  };

  const getAcpxHistory = (sessionId) => {
    if (!acpxSessionHistory.has(sessionId)) {
      acpxSessionHistory.set(sessionId, []);
    }
    return acpxSessionHistory.get(sessionId);
  };

  const pushAcpxHistory = (sessionId, role, content, extra = {}) => {
    const text = String(content || '').trim();
    if (!text) return;
    const history = getAcpxHistory(sessionId);
    history.push({
      id: randomUUID(),
      role,
      content: text,
      timestamp: Date.now(),
      ...extra,
    });
    if (history.length > 200) {
      history.splice(0, history.length - 200);
    }
  };

  const pushAcpxHistoryForKey = (sessionKey, role, content, extra = {}) => {
    const mappedSessionId = acpxSessionsByKey.get(sessionKey);
    const targetId = mappedSessionId || sessionKey;
    pushAcpxHistory(targetId, role, content, extra);
  };

  const defaultArgsByCli = {
    codex: '--ask-for-approval never --sandbox danger-full-access -c model_reasoning_effort=high --no-alt-screen',
    claude: '--dangerously-skip-permissions',
    gemini: '--approval-mode yolo',
    opencode: '',
  };

  const resolveCliArgs = (cliType) => {
    const envArgs = process.env[`OPENCLAW_${String(cliType || '').toUpperCase()}_ARGS`];
    const rawArgs = String(envArgs || defaultArgsByCli[cliType] || '').trim();
    const args = rawArgs ? rawArgs.split(' ').map((x) => x.trim()).filter(Boolean) : [];
    if (cliType === 'claude' && typeof process.getuid === 'function' && process.getuid() === 0) {
      return args.filter((arg) => arg !== '--dangerously-skip-permissions');
    }
    return args;
  };

  const stripAnsi = (text) => String(text || '').replace(
    // eslint-disable-next-line no-control-regex
    /[\u001B\u009B][[\]()#;?]*(?:(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~]|(?:].*?(?:\u0007|\u001B\\)))/g,
    '',
  );

  const cleanCliTranscript = (raw, { cliType } = {}) => {
    const plain = stripAnsi(raw)
      .replace(/\r/g, '\n')
      .replace(/\n{3,}/g, '\n\n');
    const lines = plain
      .split('\n')
      .map((line) => line.trimEnd())
      /* Strip leading Unicode decoration chars used by CLI banners (block art, box drawing, warning signs, etc.) */
      .map((line) => line.replace(/^[\s\u2580-\u259f\u2500-\u257f\u2596-\u259f\u2571-\u2573\u2594\u2595\u2581-\u2588\u26a0\u25c7]+/u, ''))
      .filter((line) => line.trim().length > 0)
      .filter((line) => !/^[\-─]{12,}$/.test(line.trim()))
      .filter((line) => !/^(YOLO Ctrl\+Y|\? for shortcuts)$/i.test(line.trim()))
      .filter((line) => !/^\*\s*Type your message or @path\/to\/file$/i.test(line.trim()))
      .filter((line) => !/^workspace\s*\(\/directory\)/i.test(line.trim()))
      .filter((line) => !/^\s*\/mnt\/.*\s+(master|main)\s+/i.test(line))
      .filter((line) => !/^Warning:\s*256-color support not detected/i.test(line.trim()))
      .filter((line) => !/^Gemini CLI v/i.test(line.trim()))
      .filter((line) => !/^Authenticated with /i.test(line.trim()))
      /* Gemini CLI startup / env messages */
      .filter((line) => !/^TERM=/i.test(line.trim()))
      .filter((line) => !/^YOLO mode/i.test(line.trim()))
      .filter((line) => !/^Approval mode:/i.test(line.trim()))
      .filter((line) => !/^No input provided/i.test(line.trim()))
      .filter((line) => !/^Gemini CLI\s/i.test(line.trim()))
      .filter((line) => !/^\s*Model:\s/i.test(line.trim()))
      .filter((line) => !/^\s*Please enter a prompt/i.test(line.trim()))
      .filter((line) => !/^;.*Ready/i.test(line.trim()))
      .filter((line) => !/^\s*no\s+sandbox/i.test(line.trim()))
      .filter((line) => !/^\s*gemini-[\w.-]+$/i.test(line.trim()))
      .filter((line) => !/^\s*\/{1,2}mnt\/.*\S+\s*$/i.test(line.trim()))
      /* Claude Code startup / interactive messages */
      .filter((line) => !/^Claude Code/i.test(line.trim()))
      .filter((line) => !/^Input must be provided/i.test(line.trim()))
      .filter((line) => !/^\/help for help/i.test(line.trim()))
      .filter((line) => !/^╭/u.test(line.trim()))
      .filter((line) => !/^╰/u.test(line.trim()))
      .filter((line) => !/^[│║]/u.test(line.trim()))
      .filter((line) => !/^Thinking\.\.\./i.test(line.trim()))
      .filter((line) => !/^Generating\.\.\./i.test(line.trim()))
      .filter((line) => !/^Waiting for response/i.test(line.trim()))
      .filter((line) => !/^Cost:.*\$/i.test(line.trim()))
      .filter((line) => !/^\s*\d+ tokens?/i.test(line.trim()))
      /* Generic interactive prompts */
      .filter((line) => !/^>\s*$/i.test(line.trim()))
      .filter((line) => !/^\\$/i.test(line.trim()))
      .filter((line) => !/^Press .* to /i.test(line.trim()))
      /* OpenCode TUI noise */
      .filter((line) => !/^[\u2584\u2588\u2580\u2591\u2592\u2593\u25a0\u2b1d\u25e3\u2503\u2500\u2502]+$/u.test(line.trim()))
      .filter((line) => !/^\s*\u25e3\s*Build\s*\u00b7/i.test(line.trim()))
      .filter((line) => !/^\s*\d+[,\.]?\d*\s*tokens?\b/i.test(line.trim()))
      .filter((line) => !/^\s*\d+%\s*used\b/i.test(line.trim()))
      .filter((line) => !/^\s*\u2b1d+$/u.test(line.trim()))
      .filter((line) => !/^opencode\s+v?\d/i.test(line.trim()));
    return lines.join('\n').trim();
  };

  const ensureAcpxLocalSession = (acpxSession) => {
    if (!acpxSession?.id) return null;
    /* Claude uses ClaudeJsonClient (--print + stream-json + --resume) which needs no PTY.
       Gemini uses GeminiPromptClient (--prompt + stream-json + --resume) which needs no PTY.
       Both work reliably on WSL and native Windows alike. */
    const cliType = String(acpxSession.cliType || '').toLowerCase();
    if (cliType === 'claude' || cliType === 'gemini' || cliType === 'opencode') {
      return null; // Prompt-based client handles the CLI; no local PTY session needed
    }
    if (acpxSession.localSessionId && sessionManager.get(acpxSession.localSessionId)) {
      return acpxSession.localSessionId;
    }
    const localSessionId = `${acpxSession.cliType}:${acpxSession.sessionKey}`;
    let existing = sessionManager.get(localSessionId);
    if (!existing) {
      existing = sessionManager.createSession(localSessionId, acpxSession.cliType, {
        command: String(
          acpxSession.options?.command
          || process.env[`OPENCLAW_${String(acpxSession.cliType || '').toUpperCase()}_CMD`]
          || acpxSession.cliType,
        ).trim(),
        args: Array.isArray(acpxSession.options?.args) ? acpxSession.options.args : resolveCliArgs(acpxSession.cliType),
        cwd: acpxSession.cwd,
        usePty: true,
      });
    }
    acpxSession.localSessionId = existing.id;
    acpxLocalOutputBuffer.set(existing.id, acpxLocalOutputBuffer.get(existing.id) || '');
    acpxLocalOutputCursor.set(existing.id, acpxLocalOutputCursor.get(existing.id) || 0);
    return existing.id;
  };

  /**
   * Dispatch a message through ClaudeJsonClient (--print --output-format stream-json --resume).
   * No PTY required; works on WSL and native Windows.
   */
  const dispatchViaClaudeJson = async (acpxSession, text) => {
    const sessionKey = acpxSession?.sessionKey || acpxSession?.id || '';
    const result = await claudeClient.submitPrompt({
      sessionKey,
      prompt: text,
    });
    return result?.text || '';
  };

  /**
   * Dispatch a message through GeminiPromptClient (--prompt --output-format stream-json --resume).
   * No PTY required; works on WSL and native Windows.
   */
  const dispatchViaGeminiPrompt = async (acpxSession, text) => {
    const sessionKey = acpxSession?.sessionKey || acpxSession?.id || '';
    const selectedModel = String(
      acpxSession?.model
      || acpxSession?.options?.model
      || ''
    ).trim();
    const result = await geminiClient.submitPrompt({
      sessionKey,
      prompt: text,
      model: selectedModel,
    });
    return result?.text || '';
  };
  /**
   * Dispatch a message through OpenCodeRunClient (run --format json --session).
   * No PTY required; works on WSL and native Windows.
   */
  const dispatchViaOpenCodeRun = async (acpxSession, text) => {
    const sessionKey = acpxSession?.sessionKey || acpxSession?.id || '';
    const selectedModel = String(
      acpxSession?.model
      || acpxSession?.options?.model
      || ''
    ).trim();
    const result = await openCodeClient.submitPrompt({
      sessionKey,
      prompt: text,
      model: selectedModel,
    });
    return result?.text || '';
  };

  /** Track which local sessions have already been warmed up */
  const warmedUpSessions = new Set();

  /**
   * Wait for a freshly-started CLI to initialise, then advance the output cursor
   * past any startup / welcome text so the next read only sees user-prompted output.
   * Waits until output stops growing (stability) rather than a fixed timeout.
   */
  const warmUpLocalSession = async (localSessionId, timeoutMs = 8000) => {
    if (!localSessionId) return;
    if (warmedUpSessions.has(localSessionId)) return;
    warmedUpSessions.add(localSessionId);
    const start = Date.now();
    let lastLen = 0;
    let stableSince = null;
    const stabilityMs = 1500;
    while (Date.now() - start < timeoutMs) {
      const buffer = String(acpxLocalOutputBuffer.get(localSessionId) || '');
      if (buffer.length > 0) {
        if (buffer.length === lastLen) {
          if (!stableSince) stableSince = Date.now();
          if (Date.now() - stableSince >= stabilityMs) {
            acpxLocalOutputCursor.set(localSessionId, buffer.length);
            return;
          }
        } else {
          lastLen = buffer.length;
          stableSince = null;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    // Timeout – just advance cursor to whatever we have
    const buffer = String(acpxLocalOutputBuffer.get(localSessionId) || '');
    acpxLocalOutputCursor.set(localSessionId, buffer.length);
  };

  const waitForAcpxLocalReply = async (localSessionId, timeoutMs = 30000, cliType) => {
    if (!localSessionId) return '';
    const start = Date.now();
    /* NOTE: We read the cursor from the map on every iteration instead of
       capturing a local snapshot.  When the buffer exceeds 8000 chars the
       `session:output` handler truncates it and adjusts
       `acpxLocalOutputCursor` backwards by the trim offset.  A stale local
       snapshot would then point past the buffer end or to a wrong position,
       causing `buffer.slice(initialCursor)` to return empty / garbled text. */
    let lastBufferLength = String(acpxLocalOutputBuffer.get(localSessionId) || '').length;
    let stableSince = null;
    const stabilityMs = ['gemini', 'claude', 'codex'].includes(String(cliType || '').toLowerCase()) ? 3500 : 1800;
    while (Date.now() - start < timeoutMs) {
      const cursor = acpxLocalOutputCursor.get(localSessionId) || 0;
      const buffer = String(acpxLocalOutputBuffer.get(localSessionId) || '');
      if (buffer.length > cursor) {
        const delta = cleanCliTranscript(buffer.slice(cursor), { cliType });
        if (delta) {
          // Check stability: has the output stopped growing?
          if (buffer.length === lastBufferLength) {
            if (!stableSince) stableSince = Date.now();
            if (Date.now() - stableSince >= stabilityMs) {
              acpxLocalOutputCursor.set(localSessionId, buffer.length);
              return delta;
            }
          } else {
            lastBufferLength = buffer.length;
            stableSince = null;
          }
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    // Final attempt – return whatever we have after timeout
    const cursor = acpxLocalOutputCursor.get(localSessionId) || 0;
    const buffer = String(acpxLocalOutputBuffer.get(localSessionId) || '');
    if (buffer.length > cursor) {
      const delta = cleanCliTranscript(buffer.slice(cursor), { cliType });
      acpxLocalOutputCursor.set(localSessionId, buffer.length);
      return delta;
    }
    return '';
  };

  const upsertFrontendSession = (session) => {
    if (!session?.id) return;
    frontendSessions.set(session.id, {
      ...session,
      updatedAt: Date.now(),
    });
  };

  const extractAcpxMessageText = (message) => {
    if (!message) return '';
    if (typeof message.content === 'string') {
      return String(message.content || '').trim();
    }
    if (Array.isArray(message.content)) {
      return message.content
        .map((part) => (typeof part?.text === 'string' ? part.text : ''))
        .join('')
        .trim();
    }
    return '';
  };

  const waitForAcpxAssistantReply = async ({
    sessionKey,
    userText,
    maxAttempts = 8,
    intervalMs = 1200,
  }) => {
    if (!client?.getSessionHistory || !sessionKey) return '';
    const wanted = String(userText || '').trim();
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const transcript = await client.getSessionHistory({ sessionKey, limit: 30 }).catch(() => null);
      const messages = Array.isArray(transcript?.messages) ? transcript.messages : [];
      let latestUserIndex = -1;
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const msg = messages[index] || {};
        if (String(msg.role || '').toLowerCase() !== 'user') continue;
        const text = extractAcpxMessageText(msg);
        if (!wanted || text === wanted) {
          latestUserIndex = index;
          break;
        }
      }
      const start = latestUserIndex >= 0 ? latestUserIndex + 1 : 0;
      for (let index = messages.length - 1; index >= start; index -= 1) {
        const msg = messages[index] || {};
        const role = String(msg.role || '').toLowerCase();
        if (role !== 'assistant' && role !== 'system') continue;
        const text = extractAcpxMessageText(msg);
        if (text) return text;
      }
      if (attempt < maxAttempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    }
    return '';
  };

  const emitStructuredSessionMessage = (sessionId, message, update = false) => {
    orchestrator.emit('session:message', {
      sessionId,
      message: { ...message },
      update,
      historyCount: getStructuredSessionState(sessionId).history.length,
    });
  };

  const pushStructuredHistory = (sessionId, message) => {
    const state = getStructuredSessionState(sessionId);
    state.history.push(message);
    return state;
  };

  const pushStructuredUserMessage = (sessionId, text) => {
    const cleanText = String(text || '').trim();
    if (!cleanText) return;
    const message = {
      id: randomUUID(),
      role: 'user',
      text: cleanText,
      source: 'frontend',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: 'completed',
    };
    pushStructuredHistory(sessionId, message);
    emitStructuredSessionMessage(sessionId, message, false);
  };

  const ensureStructuredCodexSessionBridge = () => {
    if (!codexClient?.on || codexClient.__openclawSessionBridgeBound) return;
    codexClient.__openclawSessionBridgeBound = true;

    codexClient.on('delta', ({ threadId, turnId, delta }) => {
      const sessionId = structuredCodexThreadToSession.get(threadId);
      if (!sessionId) return;
      const state = getStructuredSessionState(sessionId);
      const cleanDelta = pickStructuredText(delta);
      if (!cleanDelta) return;

      if (turnId && state.activeTurnId && turnId !== state.activeTurnId && state.activeAssistantMessageId) {
        const prevMsg = state.history.find((item) => item.id === state.activeAssistantMessageId);
        if (prevMsg) {
          prevMsg.status = 'completed';
          prevMsg.updatedAt = Date.now();
          emitStructuredSessionMessage(sessionId, prevMsg, true);
        }
        state.activeAssistantMessageId = null;
        state.activeText = '';
      }
      if (turnId) {
        state.activeTurnId = turnId;
      }

      const now = Date.now();
      let message = state.history.find((item) => item.id === state.activeAssistantMessageId) || null;
      if (!message) {
        message = {
          id: randomUUID(),
          role: 'assistant',
          text: cleanDelta,
          source: 'codex-structured',
          turnId: turnId || state.activeTurnId || null,
          createdAt: now,
          updatedAt: now,
          status: 'streaming',
        };
        state.activeAssistantMessageId = message.id;
        state.activeText = cleanDelta;
        pushStructuredHistory(sessionId, message);
        emitStructuredSessionMessage(sessionId, message, false);
      } else {
        state.activeText = mergeStructuredText(state.activeText, cleanDelta);
        message.text = state.activeText;
        message.turnId = turnId || message.turnId || null;
        message.updatedAt = now;
        message.status = 'streaming';
        emitStructuredSessionMessage(sessionId, message, true);
      }

      orchestrator.emit('session:output', {
        sessionId,
        data: state.activeText || message.text || cleanDelta,
      });
    });

    codexClient.on('turn:completed', ({ threadId, turn }) => {
      const sessionId = structuredCodexThreadToSession.get(threadId);
      if (!sessionId) return;
      const state = getStructuredSessionState(sessionId);
      const message = state.history.find((item) => item.id === state.activeAssistantMessageId);
      if (message) {
        message.status = 'completed';
        message.updatedAt = Date.now();
        message.turnId = turn?.id || message.turnId || null;
        emitStructuredSessionMessage(sessionId, message, true);
      }
      state.activeAssistantMessageId = null;
      state.activeTurnId = turn?.id || null;
      state.activeText = '';
    });
  };

  ensureStructuredCodexSessionBridge();
  sessionManager.on?.('session:output', (sessionId, data) => {
    if (!sessionId || !data) return;
    const previous = String(acpxLocalOutputBuffer.get(sessionId) || '');
    const next = `${previous}${String(data)}`;
    const truncated = next.slice(-8000);
    const trimOffset = next.length - truncated.length;
    if (trimOffset > 0) {
      const currentCursor = acpxLocalOutputCursor.get(sessionId) || 0;
      acpxLocalOutputCursor.set(sessionId, Math.max(0, currentCursor - trimOffset));
    }
    acpxLocalOutputBuffer.set(sessionId, truncated);
  });

  const pickText = (input) => {
    if (typeof input === 'string') return input.trim();
    if (Array.isArray(input)) {
      return input
        .map((item) => {
          if (typeof item === 'string') return item;
          if (typeof item?.text === 'string') return item.text;
          if (typeof item?.content === 'string') return item.content;
          return '';
        })
        .join('')
        .trim();
    }
    if (input && typeof input === 'object') {
      if (typeof input.text === 'string') return input.text.trim();
      if (typeof input.message === 'string') return input.message.trim();
      if (typeof input.content === 'string') return input.content.trim();
      if (Array.isArray(input.content)) return pickText(input.content);
    }
    return '';
  };

  const normalizeBridgeInboundPayload = (payload) => {
    const root = payload && typeof payload === 'object' ? payload : {};
    const event = (root.event && typeof root.event === 'object')
      ? root.event
      : (root.data && typeof root.data === 'object')
        ? root.data
        : root;
    const typeRaw = String(
      event.type
      || event.eventType
      || event.event_type
      || root.type
      || root.eventType
      || root.event_type
      || 'message',
    ).trim().toLowerCase();
    const messageType = typeRaw || 'message';
    const supported = new Set(['message', 'chat.message', 'session.message', 'conversation.message']);
    if (!supported.has(messageType)) {
      return { ignoredReason: `Unsupported event type: ${messageType}` };
    }
    const sessionKey = String(
      event.sessionKey
      || event.session_key
      || root.sessionKey
      || root.session_key
      || event.metadata?.sessionKey
      || root.metadata?.sessionKey
      || '',
    ).trim();
    const agentFromSession = sessionKey.startsWith('agent:') ? (sessionKey.split(':')[1] || '') : '';
    const agentId = String(
      event.agentId
      || event.agent_id
      || root.agentId
      || root.agent_id
      || event.agent?.id
      || root.agent?.id
      || event.metadata?.agentId
      || root.metadata?.agentId
      || agentFromSession
      || '',
    ).trim();
    const threadId = String(
      event.threadId
      || event.thread_id
      || root.threadId
      || root.thread_id
      || event.messageThreadId
      || event.message_thread_id
      || event.thread?.id
      || root.thread?.id
      || event.conversationId
      || event.conversation_id
      || root.conversationId
      || root.conversation_id
      || event.chatId
      || event.chat_id
      || root.chatId
      || root.chat_id
      || event.open_message_id
      || root.open_message_id
      || event.messageId
      || event.message_id
      || root.messageId
      || root.message_id
      || event.message?.id
      || root.message?.id
      || '',
    ).trim();
    const text = pickText(
      event.text
      || event.message
      || event.content
      || event.message?.content
      || root.text
      || root.message
      || root.content
      || root.message?.content,
    );
    const runtime = String(event.runtime || root.runtime || 'codex').trim().toLowerCase();
    const finalSessionKey = sessionKey || (agentId ? `agent:${agentId}` : '');
    const finalThreadId = threadId || (finalSessionKey ? `thread:${finalSessionKey}` : '');
    if (!text || !finalSessionKey || !finalThreadId) {
      return { invalidReason: 'Unable to resolve text/sessionKey/threadId from inbound event' };
    }
    return {
      eventType: messageType,
      source: String(root.source || root.provider || 'openclaw-channel').trim() || 'openclaw-channel',
      agentId: agentId || (finalSessionKey.startsWith('agent:') ? finalSessionKey.slice('agent:'.length) : ''),
      sessionKey: finalSessionKey,
      threadId: finalThreadId,
      text,
      runtime,
      taskId: String(event.taskId || root.taskId || '').trim(),
      runId: String(event.runId || root.runId || '').trim(),
    };
  };

  const upsertBridgeThread = ({ threadId, runId, taskId, sessionKey, agentId, status, controlState, message, attempt }) => {
    const key = String(threadId || '').trim();
    if (!key) return null;
    const current = bridgeThreads.get(key) || {
      threadId: key,
      sessionKey,
      agentId,
      runs: [],
      updatedAt: Date.now(),
      status: status || 'unknown',
      controlState: controlState || 'running',
      lastMessage: '',
    };
    const runEntry = {
      runId,
      taskId,
      status: status || 'unknown',
      controlState: controlState || 'running',
      attempt: Number(attempt || 1),
      updatedAt: Date.now(),
    };
    const dedup = current.runs.filter((item) => item.runId !== runId).slice(0, 19);
    current.runs = [runEntry, ...dedup];
    current.updatedAt = Date.now();
    current.status = runEntry.status;
    current.controlState = runEntry.controlState;
    current.lastMessage = String(message || '').slice(0, 500);
    current.sessionKey = sessionKey || current.sessionKey;
    current.agentId = agentId || current.agentId;
    bridgeThreads.set(key, current);
    return current;
  };

  const callbackUrl = process.env.AUTOCLI_CALLBACK_URL || '';
  const TERMINAL_STATUSES = new Set(['completed', 'failed', 'terminated']);

  orchestrator.on('run:event', (event) => {
    upsertBridgeThread({
      threadId: event.threadId,
      runId: event.runId,
      taskId: event.taskId,
      sessionKey: event.sessionKey,
      agentId: event.agentId,
      status: event.status,
      controlState: event.controlState,
      message: event.message,
      attempt: event.attempt,
    });

    if (TERMINAL_STATUSES.has(event.status) && event.sessionKey) {
      const task = orchestrator.tasks?.get(event.taskId);
      const answer = task?.answerText || event.message || '';
      const errText = task?.error || '';
      // Minimal notification — let the session agent query and summarize the result itself
      const baseUrl = process.env.AUTOCLI_BASE_URL || 'http://127.0.0.1:8700';
      let msg = `[autocli] task \`${event.taskId}\` → **${event.status}**`;
      if (errText) msg += `\nError: ${errText.slice(0, 120)}`;
      msg += `\n\n请调用 \`GET ${baseUrl}/tasks/${event.taskId}\` 获取完整结果并总结输出。`;

      if (client?.sendSessionMessage) {
        client.sendSessionMessage({ sessionKey: event.sessionKey, message: msg, deliver: false })
          .catch((err) => console.warn('[callback] sendSessionMessage failed:', err.message));
      }

      // Also HTTP callback if configured
      if (callbackUrl) {
        fetch(callbackUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            taskId: event.taskId,
            sessionKey: event.sessionKey,
            status: event.status,
            answerText: answer,
            error: errText,
            completedAt: task?.completedAt || event.ts,
          }),
          signal: AbortSignal.timeout(10000),
        }).catch((err) => console.warn('[callback] http failed:', err.message));
      }
    }
  });

  const normalizeTaskPayload = (payload) => {
    const normalized = { ...(payload || {}) };
    if (!normalized.prompt || typeof normalized.prompt !== 'string' || !normalized.prompt.trim()) {
      normalized.prompt = '';
    }
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
    if (!normalized.agentId && normalized.metadata.agentId) {
      normalized.agentId = normalized.metadata.agentId;
    }
    if (!normalized.threadId && normalized.metadata.threadId) {
      normalized.threadId = normalized.metadata.threadId;
    }
    if (!normalized.attempt) {
      normalized.attempt = Number(normalized.metadata.attempt || 1);
    }
    normalized.metadata = {
      ...normalized.metadata,
      ...(normalized.agentId ? { agentId: normalized.agentId } : {}),
      ...(normalized.threadId ? { threadId: normalized.threadId } : {}),
      attempt: Number(normalized.attempt || 1),
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
      agentId: task.agentId || task.metadata?.agentId || null,
      threadId: task.threadId || task.metadata?.threadId || null,
      attempt: Number(task.attempt || task.metadata?.attempt || 1),
      controlState: task.controlState || 'running',
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
      let upstream = { ok: true, status: 'disabled' };
      const clientBaseUrl = String(client?.baseUrl || '').trim();
      let shouldProbeUpstream = typeof client?.health === 'function';
      if (shouldProbeUpstream && clientBaseUrl) {
        try {
          const parsed = new URL(clientBaseUrl);
          const upstreamHost = String(parsed.hostname || '').toLowerCase();
          const upstreamPort = String(parsed.port || (parsed.protocol === 'https:' ? '443' : '80'));
          const selfPort = String(process.env.PORT || '8700');
          if ((upstreamHost === '127.0.0.1' || upstreamHost === 'localhost') && upstreamPort === selfPort) {
            shouldProbeUpstream = false;
            upstream = { ok: true, status: 'self-acpx' };
          }
        } catch {
          // keep default behavior when base url is not parseable
        }
      }
      if (shouldProbeUpstream) {
        upstream = await client.health().catch((error) => ({ ok: false, error: error.message }));
      }
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
          const cliType = String(payload.cliType || 'codex').trim().toLowerCase();
      const options = { ...(payload.options || {}) };
      const defaultWorkspacePath = createWorkspaceCwd({
        sessionId: payload.id || payload.sessionId || randomUUID(),
        cliType,
        cwd: options.cwd,
      });
      if (!options.cwd) {
        options.cwd = defaultWorkspacePath;
      }

      if (cliType === 'codex') {
        /* Probe codex app-server availability. If unavailable, fall through to acpx-local fallback. */
        let codexStructuredAvailable = false;
        try {
          codexStructuredAvailable = await codexClient.isAvailable();
        } catch {
          codexStructuredAvailable = false;
        }

        if (codexStructuredAvailable) {
        const requested = String(payload.id || '').trim();
        const sessionKey = toCodexSessionKey(requested || randomUUID());
        const sessionId = toCodexSessionId(sessionKey);
        const placeholder = {
          id: sessionId,
          cliType: 'codex',
          status: 'idle',
          transport: 'structured',
          sessionKey,
          cwd: options.cwd || createWorkspaceCwd({
            sessionId,
            cliType: 'codex',
            cwd: options.cwd,
            workspaceRoot,
          }),
          /* Intentionally do not pin a model at session create time for Codex.
             Passing frontend-provided model strings here can break structured chat
             when the model name is not valid for Codex CLI. */
          model: '',
          options: { ...options, model: '' },
          createdAt: Date.now(),
        };
        structuredCodexSessions.set(sessionId, placeholder);
        upsertFrontendSession({
          id: placeholder.id,
          cliType: 'codex',
          status: 'idle',
          transport: 'structured',
          sessionKey,
          cwd: placeholder.cwd,
          upstream: null,
          createdAt: Date.now(),
        });
        sendJson(200, {
          ok: true,
          session: frontendSessions.get(placeholder.id),
        });
        return;
        }
        /* app-server unavailable — fall through to acpx-local path below.
           Clear any stale `transport: 'structured'` from the request so the
           session isn't created with a transport that has no backend. */
        if (options.transport === 'structured') options.transport = '';
        if (payload.transport === 'structured') payload.transport = '';
      }

      const sessionId = payload.id || `${cliType}-${randomUUID()}`;
      const sessionKey = String(options.sessionKey || payload.sessionKey || sessionId).trim();
      const cwd = createWorkspaceCwd({
        sessionId,
        cliType,
        cwd: options.cwd,
        workspaceRoot,
      });

      const transport = String(options.transport || payload.transport || '').trim().toLowerCase();
      /* Include 'codex' so that when codex app-server is unavailable the session
         is created as acpx-local (with local PTY fallback) instead of the
         dead-end local-cli path that has no reply mechanism. */
      const preferAcpx = ['claude', 'gemini', 'codex', 'opencode'].includes(cliType) && transport !== 'local-cli';
      if (preferAcpx && client?.ensureSession) {
        try {
          /* NOTE: We intentionally skip supportsSessionChat() here.
             When OPENCLAW_BASE_URL points to the backend itself, that call
             causes a self-deadlock.  Since we have local fallback strategies
             (ClaudeJsonClient for Claude, local CLI for Gemini), we just
             try the gateway and fall back on failure. */
          const requestedModel = String(options.model || payload.model || '').trim();
          let gatewayAvailable = false;
          try {
            await client.ensureSession({
              sessionKey,
              label: `${cliType.toUpperCase()} / ${sessionKey}`,
              ...(requestedModel ? { model: requestedModel } : {}),
            });
            gatewayAvailable = true;
          } catch (gatewayError) {
            gatewayAvailable = false;
          }
          const acpxSessionId = payload.id || `${cliType}-${randomUUID()}`;
          const acpxSession = {
            id: acpxSessionId,
            cliType,
            status: 'idle',
            sessionKey,
            transport: gatewayAvailable ? 'acpx' : 'acpx-local',
            cwd,
            options: { ...options, cwd, sessionKey, transport: gatewayAvailable ? 'acpx' : 'acpx-local', ...(requestedModel ? { model: requestedModel } : {}) },
            model: requestedModel,
            upstream: gatewayAvailable
              ? { provider: 'openclaw', sessionKey }
              : { provider: 'local-fallback', sessionKey },
            createdAt: Date.now(),
          };
          acpxSessions.set(acpxSession.id, acpxSession);
          upsertFrontendSession(acpxSession);
          getAcpxHistory(acpxSession.id);
          /* Notify the user when codex app-server is unavailable and the session
             falls back to local PTY mode. */
          if (!gatewayAvailable && cliType === 'codex') {
            const notice = 'Codex app-server is not available. Falling back to local CLI mode (PTY). '
              + 'Start `codex app-server` for structured transport support.';
            pushAcpxHistory(acpxSession.id, 'system', notice, { source: 'codex-structured-fallback' });
            orchestrator.emit('session:message', {
              sessionId: acpxSession.id,
              message: { id: randomUUID(), role: 'system', text: notice, source: 'codex-structured-fallback', createdAt: Date.now(), updatedAt: Date.now(), status: 'completed' },
              update: false,
              historyCount: getAcpxHistory(acpxSession.id).length,
            });
          }
          if (sessionKey) {
            openClawSessionBindings.set(sessionKey, acpxSession.id);
            acpxSessionsByKey.set(sessionKey, acpxSession.id);
          }
          sendJson(200, { ok: true, session: acpxSession });
          return;
        } catch (error) {
          sendJson(502, { ok: false, error: `ACPX session create failed for ${cliType}: ${error.message}` });
          return;
        }
      }

      const command = String(options.command || process.env[`OPENCLAW_${cliType.toUpperCase()}_CMD`] || cliType).trim();

      if (!Array.isArray(options.args)) {
        const defaultArgsByCli = {
          codex: '--ask-for-approval never --sandbox danger-full-access -c model_reasoning_effort=high --no-alt-screen',
          claude: '--dangerously-skip-permissions',
          gemini: '--approval-mode yolo',
          opencode: '',
        };
        const envArgs = process.env[`OPENCLAW_${cliType.toUpperCase()}_ARGS`];
        const rawArgs = String(envArgs || defaultArgsByCli[cliType] || '').trim();
        options.args = rawArgs ? rawArgs.split(' ').map((x) => x.trim()).filter(Boolean) : [];
      }

      const session = sessionManager.createSession(sessionId, cliType, {
        ...options,
        command,
        cwd,
      });
      const bridgeSessionKey = String(options.bridgeSessionKey || payload.bridgeSessionKey || sessionKey).trim();
      if (bridgeSessionKey) {
        openClawSessionBindings.set(bridgeSessionKey, session.id);
      }
      const frontendSession = {
        id: session.id,
        cliType: session.cliType,
        status: session.status,
        transport: 'local-cli',
        sessionKey,
        bridgeSessionKey: bridgeSessionKey || null,
        cwd,
        upstream: null,
        createdAt: Date.now(),
      };
      upsertFrontendSession(frontendSession);
      sendJson(200, {
        ok: true,
        session: frontendSession,
      });
      return;
    }

    if (pathname === '/sessions' && req.method === 'GET') {
      const all = [...frontendSessions.values()];
      for (const localSession of sessionManager.list()) {
        const existing = frontendSessions.get(localSession.id);
        if (!existing) continue;
        all.push({
          ...existing,
          status: localSession.status || existing.status,
          command: localSession.command,
          args: localSession.args,
          cwd: localSession.cwd || existing.cwd,
        });
      }
      sendJson(200, {
        ok: true,
        sessions: all,
      });
      return;
    }

    const sessionHistoryMatch = pathname.match(/^\/sessions\/([^/]+)\/history$/);
    if (sessionHistoryMatch && req.method === 'GET') {
      const requestedId = decodeURIComponent(sessionHistoryMatch[1]);
      const history = orchestrator.getSessionHistory(requestedId);
      if (history) {
        sendJson(200, { ok: true, sessionId: requestedId, history });
        return;
      }

      const codexRequestedId = toCodexSessionId(requestedId);
      const acpxHistory = acpxSessionHistory.get(requestedId);
      if (acpxHistory) {
        sendJson(200, { ok: true, sessionId: requestedId, history: [...acpxHistory] });
        return;
      }
      const structuredState = structuredCodexStateBySession.get(requestedId) || structuredCodexStateBySession.get(codexRequestedId);
      if (structuredState) {
        sendJson(200, {
          ok: true,
          sessionId: requestedId,
          history: structuredState.history.map((item) => ({
            id: item.id,
            role: item.role,
            content: item.text,
            timestamp: item.updatedAt || item.createdAt,
            status: item.status,
            source: item.source,
            turnId: item.turnId || null,
          })),
        });
        return;
      }

      const existsAsSession = Boolean(
        frontendSessions.get(requestedId)
        ||
        sessionManager.get(requestedId)
        || codexClient.getSession(requestedId)
        || claudeClient.getSession(requestedId)
        || acpxSessions.get(requestedId)
        || structuredCodexSessions.get(requestedId)
        || structuredCodexSessions.get(codexRequestedId)
      );

      if (!existsAsSession) {
        sendJson(404, { ok: false, error: `Unknown session: ${requestedId}` });
        return;
      }

      sendJson(200, { ok: true, sessionId: requestedId, history: [] });
      return;
    }

    const sessionDispatchMatch = pathname.match(/^\/sessions\/([^/]+)\/dispatch$/);
    if (sessionDispatchMatch && req.method === 'POST') {
      const requestedId = decodeURIComponent(sessionDispatchMatch[1]);
      const payload = await readJson();
      const text = String(payload.message ?? payload.text ?? '').trim();
      if (!text) {
        sendJson(400, { ok: false, error: 'message is required' });
        return;
      }
      try {
        const frontendSession = frontendSessions.get(requestedId);
        const acpxSession = acpxSessions.get(requestedId) || (['acpx', 'acpx-local'].includes(frontendSession?.transport) ? frontendSession : null);
        if (!acpxSession) {
          const dispatch = await orchestrator.dispatchSessionMessage(requestedId, {
            message: text,
            target: String(payload.target || 'openclaw'),
            openclawMode: String(payload.openclawMode || 'mirror'),
            deliver: Boolean(payload.deliver),
          });
          sendJson(200, { ok: true, sessionId: requestedId, result: dispatch });
          return;
        }
        const sessionKey = acpxSession?.sessionKey || frontendSession?.sessionKey || requestedId;

        /* 1. Try ACPX gateway dispatch first (skip if gateway is known unavailable) */
        const gatewayKnownDown = acpxSession?.transport === 'acpx-local' || acpxSession?.upstream?.provider === 'local-fallback';
        if (acpxSession && client?.sendSessionMessage && !gatewayKnownDown) {
          try {
            const acpxResult = await client.sendSessionMessage({
              sessionKey: acpxSession.sessionKey || sessionKey,
              message: text,
              target: String(payload.target || 'local'),
            });
            if (!acpxResult?.unsupported) {
              pushAcpxHistoryForKey(sessionKey, 'user', text, { source: 'session-dispatch' });
              let maybeAssistant = String(acpxResult?.summary || acpxResult?.message || acpxResult?.text || '').trim();
              if (!maybeAssistant) {
                maybeAssistant = await waitForAcpxAssistantReply({ sessionKey: acpxSession.sessionKey || sessionKey, userText: text });
              }
              /* Detect CLI error patterns in gateway response */
              const cliErrorPatterns = [
                /Input must be provided/i, /when using \-\-print/i,
                /No input provided/i, /TERM=.*dumb/i,
                /YOLO mode/i, /Approval mode:/i,
                /opencode/i,
              ];
              const looksLikeCliError = maybeAssistant && cliErrorPatterns.some((p) => p.test(maybeAssistant));
              if (!looksLikeCliError && maybeAssistant) {
                pushAcpxHistoryForKey(sessionKey, 'assistant', maybeAssistant, { source: 'acpx' });
                orchestrator.emit('session:message', {
                  sessionId: requestedId,
                  message: { id: randomUUID(), role: 'assistant', text: maybeAssistant, source: 'acpx', createdAt: Date.now(), updatedAt: Date.now(), status: 'completed' },
                  update: false,
                  historyCount: getAcpxHistory(requestedId).length,
                });
                sendJson(200, { ok: true, sessionId: requestedId, sessionKey, accepted: true, target: String(payload.target || 'local') });
                return;
              }
              /* Fall through to local CLI on error */
            }
          } catch (dispatchError) {
            if (Number(dispatchError?.status) !== 404) throw dispatchError;
            /* 404 → fall through to local CLI */
          }
        }

        /* 2. Local CLI dispatch (fallback or when ACPX unavailable) */
        pushAcpxHistoryForKey(sessionKey, 'user', text, { source: 'session-dispatch' });
        const localSessionId = acpxSession ? ensureAcpxLocalSession(acpxSession) : null;
        const localCliType = acpxSession?.cliType || null;
        const isClaudeSession = String(localCliType).toLowerCase() === 'claude';
        const isGeminiSession = String(localCliType).toLowerCase() === 'gemini';
        const isOpenCodeSession = String(localCliType).toLowerCase() === 'opencode';
        if (localSessionId) {
          const localSession = sessionManager.get(localSessionId);
          if (localSession) {
            await warmUpLocalSession(localSessionId);
          }
          sessionManager.send(localSessionId, text);
        }
        orchestrator.emit('session:message', {
          sessionId: requestedId,
          message: { id: randomUUID(), role: 'user', text, source: 'session-dispatch', createdAt: Date.now(), updatedAt: Date.now(), status: 'completed' },
          update: false,
          historyCount: getAcpxHistory(requestedId).length,
        });
        /* Get assistant response: ClaudeJsonClient for Claude, GeminiPromptClient for Gemini, local CLI for others */
        let assistantText = '';
        if (isClaudeSession && acpxSession) {
          try {
            assistantText = await dispatchViaClaudeJson(acpxSession, text);
          } catch (err) {
            assistantText = '';
          }
        } else if (isGeminiSession && acpxSession) {
          try {
            assistantText = await dispatchViaGeminiPrompt(acpxSession, text);
          } catch (err) {
            assistantText = '';
          }
        } else if (isOpenCodeSession && acpxSession) {
          try {
            assistantText = await dispatchViaOpenCodeRun(acpxSession, text);
          } catch (err) {
            assistantText = '';
          }
        } else if (localSessionId) {
          assistantText = await waitForAcpxLocalReply(localSessionId, 30000, localCliType);
        }
        if (assistantText) {
          const replySource = isClaudeSession
            ? 'claude-json'
            : (isGeminiSession ? 'gemini-prompt'
              : (isOpenCodeSession ? 'opencode-run' : 'acpx-local-cli'));
          pushAcpxHistoryForKey(sessionKey, 'assistant', assistantText, { source: replySource });
          orchestrator.emit('session:message', {
            sessionId: requestedId,
            message: { id: randomUUID(), role: 'assistant', text: assistantText, source: replySource, createdAt: Date.now(), updatedAt: Date.now(), status: 'completed' },
            update: false,
            historyCount: getAcpxHistory(requestedId).length,
          });
        }
        sendJson(200, { ok: true, sessionId: requestedId, sessionKey, accepted: true, target: String(payload.target || 'local') });
      } catch (error) {
        sendJson(500, { ok: false, error: error.message });
      }
      return;
    }

    const sessionBindMatch = pathname.match(/^\/sessions\/([^/]+)\/bind-openclaw$/);
    if (sessionBindMatch && req.method === 'POST') {
      const requestedId = decodeURIComponent(sessionBindMatch[1]);
      const payload = await readJson();
      const sessionKey = String(payload.sessionKey || '').trim();
      if (!sessionManager.get(requestedId)) {
        sendJson(404, { ok: false, error: `Unknown local session: ${requestedId}` });
        return;
      }
      if (!sessionKey) {
        sendJson(400, { ok: false, error: 'sessionKey is required' });
        return;
      }
      openClawSessionBindings.set(sessionKey, requestedId);
      sendJson(200, { ok: true, sessionId: requestedId, sessionKey, binding: 'updated' });
      return;
    }

    const sessionMatch = pathname.match(/^\/sessions\/([^/]+)$/);
    if (sessionMatch && req.method === 'DELETE') {
      const requestedId = decodeURIComponent(sessionMatch[1]);
      try {
        const removedOrchestrator = orchestrator.removeSession(requestedId, { kill: true });
        const removedCodex = codexClient.forgetSession?.(requestedId) || false;
        const removedClaude = claudeClient.forgetSession?.(requestedId) || false;
        const removedLocal = Boolean(sessionManager.get(requestedId));
        if (removedLocal) {
          sessionManager.remove(requestedId, { kill: true });
        }

        const removedStructuredCodex = structuredCodexSessions.delete(requestedId) || structuredCodexSessions.delete(toCodexSessionId(requestedId));
        for (const [key, value] of openClawSessionBindings.entries()) {
          if (value === requestedId) {
            openClawSessionBindings.delete(key);
          }
        }
        frontendSessions.delete(requestedId);
        const removedAcpxSession = acpxSessions.delete(requestedId);
        const removedAcpxHistory = acpxSessionHistory.delete(requestedId);
        structuredCodexStateBySession.delete(requestedId);
        structuredCodexStateBySession.delete(toCodexSessionId(requestedId));
        structuredCodexModelBySession.delete(requestedId);
        structuredCodexModelBySession.delete(toCodexSessionId(requestedId));
        for (const [threadId, sessionId] of structuredCodexThreadToSession.entries()) {
          if (sessionId === requestedId || sessionId === toCodexSessionId(requestedId)) {
            structuredCodexThreadToSession.delete(threadId);
          }
        }

        if (!removedOrchestrator?.removed && !removedCodex && !removedClaude && !removedLocal && !removedStructuredCodex && !removedAcpxSession && !removedAcpxHistory) {
          sendJson(404, { ok: false, error: `Unknown session: ${requestedId}` });
          return;
        }

        sendJson(200, {
          ok: true,
          result: {
            sessionId: requestedId,
            removed: true,
            removedOrchestrator,
            removedCodex,
            removedClaude,
            removedLocal,
            removedStructuredCodex,
            removedAcpxSession,
            removedAcpxHistory,
          },
        });
      } catch (error) {
        sendJson(500, { ok: false, error: error.message });
      }
      return;
    }

    if (sessionMatch && req.method === 'GET') {
      const requestedId = decodeURIComponent(sessionMatch[1]);
      const codexRequestedId = toCodexSessionId(requestedId);
      const session = frontendSessions.get(requestedId)
        ||
        sessionManager.get(requestedId)
        || codexClient.getSession(requestedId)
        || codexClient.getSession(codexRequestedId)
        || claudeClient.getSession(requestedId)
        || acpxSessions.get(requestedId)
        || structuredCodexSessions.get(requestedId)
        || structuredCodexSessions.get(codexRequestedId);
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
          bridgeSessionKeys: [...openClawSessionBindings.entries()]
            .filter(([, sessionId]) => sessionId === (session?.id || requestedId))
            .map(([key]) => key),
          transport: session?.transport || 'local-cli',
          upstream: session?.upstream || null,
          historyCount: history?.length || 0,
        },
      });
      return;
    }

    const sessionInputMatch = pathname.match(/^\/sessions\/([^/]+)\/input$/);
    if (sessionInputMatch && req.method === 'POST') {
      const requestedId = decodeURIComponent(sessionInputMatch[1]);
      const payload = await readJson();
      const messageText = String(payload.message ?? payload.text ?? '').trim();
      try {
        const outcome = await withSoftTimeout((async () => {
          const frontendSession = frontendSessions.get(requestedId);
          const session = sessionManager.get(requestedId);
          if (session) {
            sessionManager.send(requestedId, messageText);
          } else {
          const codexRequestedId = toCodexSessionId(requestedId);
          const codexSession = codexClient.getSession(requestedId) || codexClient.getSession(codexRequestedId);
          if (codexSession) {
            const codexSessionId = codexSession.id || toCodexSessionId(codexSession.sessionKey);
            pushStructuredUserMessage(codexSessionId, messageText);
            await codexClient.sendInput({
              sessionKey: codexSession.sessionKey || toCodexSessionKey(requestedId),
              threadId: codexSession.threadId,
              message: messageText,
              model: '',
            });
            if (codexSession.threadId) {
              structuredCodexThreadToSession.set(codexSession.threadId, codexSessionId);
            }
          } else {
            const placeholder = structuredCodexSessions.get(requestedId) || structuredCodexSessions.get(codexRequestedId);
            if (placeholder) {
              const placeholderSessionId = toCodexSessionId(placeholder.sessionKey) || placeholder.id;
              pushStructuredUserMessage(placeholderSessionId, messageText);
              let result;
              try {
              result = await codexClient.submitPrompt({
                sessionKey: placeholder.sessionKey,
                prompt: messageText,
                cwd: createWorkspaceCwd({
                  sessionId: placeholder.id,
                  cliType: 'codex',
                  cwd: placeholder.cwd,
                  workspaceRoot,
                }),
                model: '',
              });
              } catch (submitError) {
                /* Push error to session history so the frontend shows it */
                const errorMessage = {
                  id: randomUUID(),
                  role: 'system',
                  text: `Codex error: ${submitError.message}`,
                  source: 'codex-structured',
                  createdAt: Date.now(),
                  updatedAt: Date.now(),
                  status: 'completed',
                };
                pushStructuredHistory(placeholderSessionId, errorMessage);
                emitStructuredSessionMessage(placeholderSessionId, errorMessage, false);
                throw submitError;
              }
              const canonicalSessionId = toCodexSessionId(placeholder.sessionKey);
              structuredCodexSessions.delete(placeholder.id);
              structuredCodexSessions.delete(canonicalSessionId);
              structuredCodexThreadToSession.set(result.threadId, canonicalSessionId);
              const state = getStructuredSessionState(canonicalSessionId);
              state.activeTurnId = result.turnId || state.activeTurnId || null;
            } else {
              const acpxSession = acpxSessions.get(requestedId) || (['acpx', 'acpx-local'].includes(frontendSession?.transport) ? frontendSession : null);
              const gatewayKnownDown = acpxSession?.transport === 'acpx-local' || acpxSession?.upstream?.provider === 'local-fallback';
              const userText = messageText;
              if (acpxSession && gatewayKnownDown) {
                /* Gateway is known down — go straight to local fallback */
                const localCliType = acpxSession.cliType || null;
                const isClaudeFallback = String(localCliType).toLowerCase() === 'claude';
                const isGeminiFallback = String(localCliType).toLowerCase() === 'gemini';
                const isOpenCodeFallback = String(localCliType).toLowerCase() === 'opencode';
                pushAcpxHistory(requestedId, 'user', userText, { source: 'local-fallback' });
                if (isClaudeFallback) {
                  try {
                    const claudeReply = await dispatchViaClaudeJson(acpxSession, userText);
                    if (claudeReply) {
                      pushAcpxHistory(requestedId, 'assistant', claudeReply, { source: 'claude-json' });
                      orchestrator.emit('session:message', {
                        sessionId: requestedId,
                        message: { id: randomUUID(), role: 'assistant', text: claudeReply, source: 'claude-json', createdAt: Date.now(), updatedAt: Date.now(), status: 'completed' },
                        update: false,
                        historyCount: getAcpxHistory(requestedId).length,
                      });
                    }
                  } catch (err) {
                    const notice = `Claude fallback failed: ${err.message}`;
                    pushAcpxHistory(requestedId, 'system', notice, { source: 'claude-json' });
                    orchestrator.emit('session:message', {
                      sessionId: requestedId,
                      message: { id: randomUUID(), role: 'system', text: notice, source: 'claude-json', createdAt: Date.now(), updatedAt: Date.now(), status: 'completed' },
                      update: false,
                      historyCount: getAcpxHistory(requestedId).length,
                    });
                  }
                } else if (isGeminiFallback) {
                  try {
                    const geminiReply = await dispatchViaGeminiPrompt(acpxSession, userText);
                    if (geminiReply) {
                      pushAcpxHistory(requestedId, 'assistant', geminiReply, { source: 'gemini-prompt' });
                      orchestrator.emit('session:message', {
                        sessionId: requestedId,
                        message: { id: randomUUID(), role: 'assistant', text: geminiReply, source: 'gemini-prompt', createdAt: Date.now(), updatedAt: Date.now(), status: 'completed' },
                        update: false,
                        historyCount: getAcpxHistory(requestedId).length,
                      });
                    }
                  } catch (err) {
                    const notice = `Gemini fallback failed: ${err.message}`;
                    pushAcpxHistory(requestedId, 'system', notice, { source: 'gemini-prompt' });
                    orchestrator.emit('session:message', {
                      sessionId: requestedId,
                      message: { id: randomUUID(), role: 'system', text: notice, source: 'gemini-prompt', createdAt: Date.now(), updatedAt: Date.now(), status: 'completed' },
                      update: false,
                      historyCount: getAcpxHistory(requestedId).length,
                    });
                  }
                } else if (isOpenCodeFallback) {
                  try {
                    const openCodeReply = await dispatchViaOpenCodeRun(acpxSession, userText);
                    if (openCodeReply) {
                      pushAcpxHistory(requestedId, 'assistant', openCodeReply, { source: 'opencode-run' });
                      orchestrator.emit('session:message', {
                        sessionId: requestedId,
                        message: { id: randomUUID(), role: 'assistant', text: openCodeReply, source: 'opencode-run', createdAt: Date.now(), updatedAt: Date.now(), status: 'completed' },
                        update: false,
                        historyCount: getAcpxHistory(requestedId).length,
                      });
                    }
                  } catch (err) {
                    const notice = `OpenCode fallback failed: ${err.message}`;
                    pushAcpxHistory(requestedId, 'system', notice, { source: 'opencode-run' });
                    orchestrator.emit('session:message', {
                      sessionId: requestedId,
                      message: { id: randomUUID(), role: 'system', text: notice, source: 'opencode-run', createdAt: Date.now(), updatedAt: Date.now(), status: 'completed' },
                      update: false,
                      historyCount: getAcpxHistory(requestedId).length,
                    });
                  }
                } else {
                  const localSessionId = ensureAcpxLocalSession(acpxSession);
                  if (localSessionId) {
                    const localSession = sessionManager.get(localSessionId);
                    if (localSession) {
                      await warmUpLocalSession(localSessionId);
                    }
                    sessionManager.send(localSessionId, userText);
                    const localReply = await waitForAcpxLocalReply(localSessionId, 30000, localCliType);
                    if (localReply) {
                      pushAcpxHistory(requestedId, 'assistant', localReply, { source: 'acpx-local-cli' });
                      orchestrator.emit('session:message', {
                        sessionId: requestedId,
                        message: { id: randomUUID(), role: 'assistant', text: localReply, source: 'acpx-local-cli', createdAt: Date.now(), updatedAt: Date.now(), status: 'completed' },
                        update: false,
                        historyCount: getAcpxHistory(requestedId).length,
                      });
                    }
                  }
                }
              } else if (acpxSession && client?.sendSessionMessage && !gatewayKnownDown) {
                const userText = messageText;
                pushAcpxHistory(requestedId, 'user', userText, { source: 'acpx' });
                let acpxResult;
                try {
                  acpxResult = await client.sendSessionMessage({
                    sessionKey: acpxSession.sessionKey,
                    message: userText,
                    target: 'local',
                  });
                } catch (dispatchError) {
                  if (Number(dispatchError?.status) === 404) {
                    acpxResult = {
                      unsupported: true,
                      message: 'ACPX chat endpoints are unavailable on current upstream',
                    };
                  } else {
                    throw dispatchError;
                  }
                }
                if (acpxResult?.unsupported) {
                  /* Fall back to local CLI / ClaudeJsonClient / GeminiPromptClient when ACPX gateway is unavailable */
                  const localCliType = acpxSession.cliType || null;
                  const isClaudeFallback = String(localCliType).toLowerCase() === 'claude';
                  const isGeminiFallback = String(localCliType).toLowerCase() === 'gemini';
                  const isOpenCodeFallback = String(localCliType).toLowerCase() === 'opencode';
                  if (isClaudeFallback) {
                    /* ClaudeJsonClient: no PTY needed, works on WSL */
                    try {
                      const claudeReply = await dispatchViaClaudeJson(acpxSession, userText);
                      if (claudeReply) {
                        pushAcpxHistory(requestedId, 'assistant', claudeReply, { source: 'claude-json' });
                        orchestrator.emit('session:message', {
                          sessionId: requestedId,
                          message: {
                            id: randomUUID(),
                            role: 'assistant',
                            text: claudeReply,
                            source: 'claude-json',
                            createdAt: Date.now(),
                            updatedAt: Date.now(),
                            status: 'completed',
                          },
                          update: false,
                          historyCount: getAcpxHistory(requestedId).length,
                        });
                      }
                    } catch (err) {
                      const notice = `Claude JSON fallback failed: ${err.message}`;
                      pushAcpxHistory(requestedId, 'system', notice, { source: 'claude-json' });
                      orchestrator.emit('session:message', {
                        sessionId: requestedId,
                        message: { id: randomUUID(), role: 'system', text: notice, source: 'claude-json', createdAt: Date.now(), updatedAt: Date.now(), status: 'completed' },
                        update: false,
                        historyCount: getAcpxHistory(requestedId).length,
                      });
                    }
                  } else if (isGeminiFallback) {
                    try {
                      const geminiReply = await dispatchViaGeminiPrompt(acpxSession, userText);
                      if (geminiReply) {
                        pushAcpxHistory(requestedId, 'assistant', geminiReply, { source: 'gemini-prompt' });
                        orchestrator.emit('session:message', {
                          sessionId: requestedId,
                          message: {
                            id: randomUUID(),
                            role: 'assistant',
                            text: geminiReply,
                            source: 'gemini-prompt',
                            createdAt: Date.now(),
                            updatedAt: Date.now(),
                            status: 'completed',
                          },
                          update: false,
                          historyCount: getAcpxHistory(requestedId).length,
                        });
                      }
                    } catch (err) {
                      const notice = `Gemini prompt fallback failed: ${err.message}`;
                      pushAcpxHistory(requestedId, 'system', notice, { source: 'gemini-prompt' });
                      orchestrator.emit('session:message', {
                        sessionId: requestedId,
                        message: { id: randomUUID(), role: 'system', text: notice, source: 'gemini-prompt', createdAt: Date.now(), updatedAt: Date.now(), status: 'completed' },
                        update: false,
                        historyCount: getAcpxHistory(requestedId).length,
                      });
                    }
                  } else if (isOpenCodeFallback) {
                    try {
                      const openCodeReply = await dispatchViaOpenCodeRun(acpxSession, userText);
                      if (openCodeReply) {
                        pushAcpxHistory(requestedId, 'assistant', openCodeReply, { source: 'opencode-run' });
                        orchestrator.emit('session:message', {
                          sessionId: requestedId,
                          message: { id: randomUUID(), role: 'assistant', text: openCodeReply, source: 'opencode-run', createdAt: Date.now(), updatedAt: Date.now(), status: 'completed' },
                          update: false,
                          historyCount: getAcpxHistory(requestedId).length,
                        });
                      }
                    } catch (err) {
                      const notice = `OpenCode fallback failed: ${err.message}`;
                      pushAcpxHistory(requestedId, 'system', notice, { source: 'opencode-run' });
                      orchestrator.emit('session:message', {
                        sessionId: requestedId,
                        message: { id: randomUUID(), role: 'system', text: notice, source: 'opencode-run', createdAt: Date.now(), updatedAt: Date.now(), status: 'completed' },
                        update: false,
                        historyCount: getAcpxHistory(requestedId).length,
                      });
                    }
                  } else {
                  const localSessionId = ensureAcpxLocalSession(acpxSession);
                  if (localSessionId) {
                    const localSession = sessionManager.get(localSessionId);
                    if (localSession) {
                      await warmUpLocalSession(localSessionId);
                    }
                    sessionManager.send(localSessionId, userText);
                    const localReply = await waitForAcpxLocalReply(localSessionId, 30000, localCliType);
                    if (localReply) {
                      pushAcpxHistory(requestedId, 'assistant', localReply, { source: 'acpx-local-cli' });
                      orchestrator.emit('session:message', {
                        sessionId: requestedId,
                        message: {
                          id: randomUUID(),
                          role: 'assistant',
                          text: localReply,
                          source: 'acpx-local-cli',
                          createdAt: Date.now(),
                          updatedAt: Date.now(),
                          status: 'completed',
                        },
                        update: false,
                        historyCount: getAcpxHistory(requestedId).length,
                      });
                    }
                  } else {
                    const notice = String(acpxResult.message || 'ACPX chat endpoint unavailable');
                    pushAcpxHistory(requestedId, 'system', notice, { source: 'acpx' });
                    orchestrator.emit('session:message', {
                      sessionId: requestedId,
                      message: {
                        id: randomUUID(),
                        role: 'system',
                        text: notice,
                        source: 'acpx',
                        createdAt: Date.now(),
                        updatedAt: Date.now(),
                        status: 'completed',
                      },
                      update: false,
                      historyCount: getAcpxHistory(requestedId).length,
                    });
                  }
                  }
                  return;
                }
                let maybeAssistant = String(acpxResult?.summary || acpxResult?.message || acpxResult?.text || '').trim();
                if (!maybeAssistant) {
                  maybeAssistant = await waitForAcpxAssistantReply({
                    sessionKey: acpxSession.sessionKey,
                    userText,
                  });
                }
                /* Detect CLI error / startup text in the ACPX response and fall back to local CLI */
                const cliErrorPatterns = [
                  /Input must be provided/i,
                  /when using \-\-print/i,
                  /No input provided/i,
                  /TERM=.*dumb/i,
                  /YOLO mode/i,
                  /Approval mode:/i,
                  /Gemini CLI v/i,
                  /Claude Code/i,
                  /opencode/i,
                  /Error:.*CLI/i,
                ];
                const looksLikeCliError = maybeAssistant && cliErrorPatterns.some((p) => p.test(maybeAssistant));
                if (looksLikeCliError) {
                  maybeAssistant = '';
                  const errorCliType = acpxSession.cliType || null;
                  const isClaudeError = String(errorCliType).toLowerCase() === 'claude';
                  const isGeminiError = String(errorCliType).toLowerCase() === 'gemini';
                  const isOpenCodeError = String(errorCliType).toLowerCase() === 'opencode';
                  if (isClaudeError) {
                    try {
                      maybeAssistant = await dispatchViaClaudeJson(acpxSession, userText);
                    } catch (err) {
                      maybeAssistant = '';
                    }
                  } else if (isGeminiError) {
                    try {
                      maybeAssistant = await dispatchViaGeminiPrompt(acpxSession, userText);
                    } catch (err) {
                      maybeAssistant = '';
                    }
                  } else if (isOpenCodeError) {
                    try {
                      maybeAssistant = await dispatchViaOpenCodeRun(acpxSession, userText);
                    } catch (err) {
                      maybeAssistant = '';
                    }
                  } else {
                  const localSessionId = ensureAcpxLocalSession(acpxSession);
                  if (localSessionId) {
                    const localSession = sessionManager.get(localSessionId);
                    if (localSession) {
                      await warmUpLocalSession(localSessionId);
                    }
                    sessionManager.send(localSessionId, userText);
                    const localReply = await waitForAcpxLocalReply(localSessionId, 30000, errorCliType);
                    if (localReply) {
                      maybeAssistant = localReply;
                    }
                  }
                  }
                }
                if (maybeAssistant) {
                  pushAcpxHistory(requestedId, 'assistant', maybeAssistant, { source: 'acpx' });
                  orchestrator.emit('session:message', {
                    sessionId: requestedId,
                    message: {
                      id: randomUUID(),
                      role: 'assistant',
                      text: maybeAssistant,
                      source: 'acpx',
                      createdAt: Date.now(),
                      updatedAt: Date.now(),
                      status: 'completed',
                    },
                    update: false,
                    historyCount: getAcpxHistory(requestedId).length,
                  });
                }
              } else {
              const claudeSession = claudeClient.getSession(requestedId);
              if (!claudeSession) {
                throw new Error(`Unknown session: ${requestedId}`);
              }
              await claudeClient.sendInput({
                sessionKey: claudeSession.sessionKey,
                message: messageText,
              });
              }
            }
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

    const taskDeleteMatch = pathname.match(/^\/tasks\/([^/]+)$/);
    if (taskDeleteMatch && req.method === 'DELETE') {
      try {
        orchestrator.dismissTask(decodeURIComponent(taskDeleteMatch[1]));
        sendJson(200, { ok: true });
      } catch (error) {
        const status = error.message.includes('still active') ? 409 : 404;
        sendJson(status, { ok: false, error: error.message });
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

    if (pathname === '/acp/sessions' && req.method === 'GET') {
      const sessions = [...acpxSessions.values()].map((session) => ({
        sessionKey: session.sessionKey,
        id: session.id,
        label: session.label || null,
        model: session.model || null,
        runtime: session.cliType || null,
        transport: session.transport || 'acpx',
        createdAt: session.createdAt || null,
      }));
      sendJson(200, { ok: true, sessions });
      return;
    }

    if (pathname === '/acp/sessions' && req.method === 'POST') {
      const payload = await readJson();
      const sessionKey = String(payload.sessionKey || payload.key || payload.id || randomUUID()).trim();
      if (!sessionKey) {
        sendJson(400, { ok: false, error: 'sessionKey is required' });
        return;
      }
      const existingId = acpxSessionsByKey.get(sessionKey);
      if (existingId) {
        const existing = acpxSessions.get(existingId);
        sendJson(200, {
          ok: true,
          session: {
            sessionKey,
            id: existing?.id || existingId,
            label: existing?.label || null,
            model: existing?.model || null,
            runtime: existing?.cliType || null,
            transport: 'acpx',
          },
        });
        return;
      }

      const lowerLabel = String(payload.label || '').toLowerCase();
      const lowerModel = String(payload.model || '').toLowerCase();
      let cliType = 'codex';
      if (lowerLabel.includes('claude') || lowerModel.includes('claude')) cliType = 'claude';
      else if (lowerLabel.includes('gemini') || lowerModel.includes('gemini')) cliType = 'gemini';
      const sessionId = `acpx-${sessionKey}`;
      const session = {
        id: sessionId,
        cliType,
        status: 'idle',
        sessionKey,
        transport: 'acpx',
        cwd: createWorkspaceCwd({
          sessionId,
          cliType,
          workspaceRoot,
        }),
        options: {
          model: String(payload.model || '').trim(),
          transport: 'acpx',
          sessionKey,
        },
        model: String(payload.model || '').trim(),
        label: String(payload.label || '').trim() || null,
        upstream: { provider: 'acpx-local', sessionKey },
        createdAt: Date.now(),
      };
      ensureAcpxLocalSession(session);
      acpxSessions.set(session.id, session);
      acpxSessionsByKey.set(sessionKey, session.id);
      getAcpxHistory(session.id);
      upsertFrontendSession(session);
      sendJson(200, {
        ok: true,
        session: {
          sessionKey,
          id: session.id,
          label: session.label,
          model: session.model,
          runtime: session.cliType,
          transport: 'acpx',
        },
      });
      return;
    }

    const acpRunPauseMatch = pathname.match(/^\/acp\/runs\/([^/]+)\/pause$/);
    if (acpRunPauseMatch && req.method === 'POST') {
      const task = resolveTaskByRunRef(acpRunPauseMatch[1]);
      if (!task) {
        sendJson(404, { ok: false, error: 'Unknown run' });
        return;
      }
      try {
        const paused = orchestrator.pauseTask(task.id, 'acp-pause');
        sendJson(200, { ok: true, run: toRunPayload(paused), task: paused });
      } catch (error) {
        sendJson(error.code === 'TASK_NOT_PAUSABLE' ? 409 : 502, { ok: false, error: error.message, code: error.code || null });
      }
      return;
    }

    const acpRunResumeMatch = pathname.match(/^\/acp\/runs\/([^/]+)\/resume$/);
    if (acpRunResumeMatch && req.method === 'POST') {
      const task = resolveTaskByRunRef(acpRunResumeMatch[1]);
      if (!task) {
        sendJson(404, { ok: false, error: 'Unknown run' });
        return;
      }
      try {
        const resumed = await orchestrator.resumeTask(task.id, 'acp-resume');
        sendJson(200, { ok: true, run: toRunPayload(resumed), task: resumed });
      } catch (error) {
        sendJson(error.code === 'TASK_NOT_PAUSED' ? 409 : 502, { ok: false, error: error.message, code: error.code || null });
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
      const mappedSessionId = acpxSessionsByKey.get(sessionKey);
      const acpxHistory = mappedSessionId ? getAcpxHistory(mappedSessionId) : [];
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
          messages: [...acpxHistory].map((msg) => ({
            id: msg.id,
            role: msg.role,
            content: msg.content,
            timestamp: msg.timestamp,
            source: msg.source || null,
          })),
        },
      });
      return;
    }

    const acpSessionDispatchMatch = pathname.match(/^\/acp\/sessions\/([^/]+)\/dispatch$/);
    if (acpSessionDispatchMatch && req.method === 'POST') {
      const sessionKey = decodeURIComponent(acpSessionDispatchMatch[1]);
      const payload = await readJson();
      const text = String(payload.message || payload.text || '').trim();
      if (!text) {
        sendJson(400, { ok: false, error: 'message is required' });
        return;
      }
      pushAcpxHistoryForKey(sessionKey, 'user', text, { source: 'acpx-dispatch' });
      const mappedSessionId = acpxSessionsByKey.get(sessionKey) || sessionKey;
      let mappedSession = mappedSessionId ? acpxSessions.get(mappedSessionId) : null;
      if (!mappedSession) {
        mappedSession = acpxSessions.get(sessionKey) || null;
      }
      const localSessionId = mappedSession ? ensureAcpxLocalSession(mappedSession) : null;
      const localCliType = mappedSession?.cliType || null;
      const isClaudeSession = String(localCliType).toLowerCase() === 'claude';
      const isGeminiSession = String(localCliType).toLowerCase() === 'gemini';
      const isOpenCodeSession = String(localCliType).toLowerCase() === 'opencode';
      if (localSessionId) {
        // Warm up: wait for CLI initialisation and advance cursor past startup banners
        const localSession = sessionManager.get(localSessionId);
        if (localSession) {
          await warmUpLocalSession(localSessionId);
        }
        sessionManager.send(localSessionId, text);
      }
      orchestrator.emit('session:message', {
        sessionId: mappedSessionId,
        message: {
          id: randomUUID(),
          role: 'user',
          text,
          source: 'acpx-dispatch',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          status: 'completed',
        },
        update: false,
        historyCount: getAcpxHistory(mappedSessionId).length,
      });
      /* Get assistant response: ClaudeJsonClient for Claude, GeminiPromptClient for Gemini, local CLI for others */
      let assistantText = '';
      if (isClaudeSession && mappedSession) {
        try {
          assistantText = await dispatchViaClaudeJson(mappedSession, text);
        } catch (err) {
          assistantText = '';
        }
      } else if (isGeminiSession && mappedSession) {
        try {
          assistantText = await dispatchViaGeminiPrompt(mappedSession, text);
        } catch (err) {
          assistantText = '';
        }
      } else if (isOpenCodeSession && mappedSession) {
        try {
          assistantText = await dispatchViaOpenCodeRun(mappedSession, text);
        } catch (err) {
          assistantText = '';
        }
      } else if (localSessionId) {
        assistantText = await waitForAcpxLocalReply(localSessionId, 30000, localCliType);
      }
      if (assistantText) {
        const replySource = isClaudeSession
          ? 'claude-json'
          : (isGeminiSession ? 'gemini-prompt'
            : (isOpenCodeSession ? 'opencode-run' : 'acpx-local-cli'));
        pushAcpxHistoryForKey(sessionKey, 'assistant', assistantText, { source: replySource });
        orchestrator.emit('session:message', {
          sessionId: mappedSessionId,
          message: {
            id: randomUUID(),
            role: 'assistant',
            text: assistantText,
            source: replySource,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            status: 'completed',
          },
          update: false,
          historyCount: getAcpxHistory(mappedSessionId).length,
        });
      }
      sendJson(200, {
        ok: true,
        sessionKey,
        accepted: true,
        target: String(payload.target || 'local'),
      });
      return;
    }

    if ((pathname === '/bridge/feishu/events' || pathname === '/bridge/openclaw/channel/events') && req.method === 'POST') {
      if (!authorizeBridgeRequest(req)) {
        sendJson(401, { ok: false, error: 'Unauthorized bridge request' });
        return;
      }
      const payload = await readJson();
      const normalizedEvent = normalizeBridgeInboundPayload(payload);
      if (normalizedEvent.ignoredReason) {
        sendJson(200, { ok: true, ignored: true, reason: normalizedEvent.ignoredReason });
        return;
      }
      if (normalizedEvent.invalidReason) {
        sendJson(400, { ok: false, error: normalizedEvent.invalidReason });
        return;
      }
      const { agentId, threadId, text, runtime, sessionKey, source, taskId, runId } = normalizedEvent;
      const boundLocalSessionId = openClawSessionBindings.get(sessionKey);
      if (boundLocalSessionId) {
        try {
          sessionManager.send(boundLocalSessionId, text);
          orchestrator.emit('session:message', {
            sessionId: boundLocalSessionId,
            message: {
              id: randomUUID(),
              role: 'user',
              text,
              source: source || 'openclaw-channel',
              createdAt: Date.now(),
              updatedAt: Date.now(),
              status: 'completed',
            },
            update: false,
          });
          sendJson(200, {
            ok: true,
            routed: 'local-session',
            sessionKey,
            localSessionId: boundLocalSessionId,
          });
          return;
        } catch (error) {
          sendJson(502, {
            ok: false,
            error: `Failed to route inbound message to local session ${boundLocalSessionId}: ${error.message}`,
          });
          return;
        }
      }
      const baseTaskId = String(taskId || `bridge-${threadId}-${Date.now()}`).trim();
      const requestedRunId = String(runId || `run:${baseTaskId}`).trim();

      let attempt = 1;
      let lastError = null;
      let created = null;
      while (attempt <= bridgeMaxRetry && !created) {
        const finalTaskId = attempt === 1 ? baseTaskId : `${baseTaskId}-retry-${attempt}`;
        const finalRunId = attempt === 1 ? requestedRunId : `${requestedRunId}-retry-${attempt}`;
        const runPayload = normalizeTaskPayload({
          id: finalTaskId,
          taskId: finalTaskId,
          runId: finalRunId,
          runtime,
          prompt: text,
          sessionKey,
          agentId,
          threadId,
          attempt,
          metadata: {
            source,
            agentId,
            threadId,
            attempt,
            allowParallelInSession: true,
          },
        });
        try {
          orchestrator.addTask(runPayload);
          const outcome = await withSoftTimeout(
            orchestrator.submitTask(runPayload.id),
            () => ({ status: 'submitted', deferred: true }),
          );
          const task = orchestrator.getTask(runPayload.id);
          created = {
            deferred: outcome.deferred,
            run: toRunPayload(task),
            result: outcome.value,
          };
        } catch (error) {
          lastError = error;
          const retryable = error.code !== 'SESSION_BUSY';
          if (!retryable || attempt >= bridgeMaxRetry) break;
          attempt += 1;
        }
      }
      if (!created) {
        sendJson(lastError?.code === 'SESSION_BUSY' ? 409 : 502, {
          ok: false,
          error: lastError?.message || 'bridge submit failed',
          code: lastError?.code || null,
        });
        return;
      }
      upsertBridgeThread({
        threadId,
        runId: created.run.runId,
        taskId: created.run.taskId,
        sessionKey,
        agentId,
        status: created.run.status,
        controlState: created.run.controlState,
        message: created.run.answerText,
        attempt: created.run.attempt,
      });
      sendJson(200, { ok: true, threadId, sessionKey, ...created });
      return;
    }

    const bridgeThreadControlMatch = pathname.match(/^\/bridge\/threads\/([^/]+)\/control$/);
    if (bridgeThreadControlMatch && req.method === 'POST') {
      const threadId = decodeURIComponent(bridgeThreadControlMatch[1]);
      const payload = await readJson();
      const action = String(payload.action || '').trim().toLowerCase();
      const task = orchestrator.getTaskByThreadId(threadId);
      if (!task) {
        sendJson(404, { ok: false, error: `Unknown thread: ${threadId}` });
        return;
      }
      try {
        if (action === 'pause') {
          const paused = orchestrator.pauseTask(task.id, 'bridge-control');
          sendJson(200, { ok: true, action, run: toRunPayload(paused), task: paused });
        } else if (action === 'resume') {
          const resumed = await orchestrator.resumeTask(task.id, 'bridge-control');
          sendJson(200, { ok: true, action, run: toRunPayload(resumed), task: resumed });
        } else if (action === 'terminate') {
          const terminated = orchestrator.terminateTask(task.id, 'bridge-control');
          sendJson(200, { ok: true, action, run: toRunPayload(terminated), task: terminated });
        } else {
          sendJson(400, { ok: false, error: 'Unsupported action. Use pause|resume|terminate' });
        }
      } catch (error) {
        sendJson(409, { ok: false, error: error.message, code: error.code || null });
      }
      return;
    }

    const bridgeThreadMatch = pathname.match(/^\/bridge\/threads\/([^/]+)$/);
    if (bridgeThreadMatch && req.method === 'GET') {
      const threadId = decodeURIComponent(bridgeThreadMatch[1]);
      const snapshot = bridgeThreads.get(threadId);
      if (!snapshot) {
        sendJson(404, { ok: false, error: `Unknown thread: ${threadId}` });
        return;
      }
      sendJson(200, { ok: true, thread: snapshot });
      return;
    }

    sendJson(200, { ok: true, service: 'openclaw-backend' });
  });
}
