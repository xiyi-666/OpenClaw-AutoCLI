import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Plus,
  Send,
  ChevronDown,
  MessageSquare,
  Loader2,
  AlertTriangle,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { sessionApi } from '../api';
import { useWsMessages } from '../useWebSocket';
import type {
  Session,
  SessionHistoryItem,
  CreateSessionPayload,
  WsMessage,
} from '../types';

function cn(...inputs: (string | boolean | undefined | null)[]) {
  return twMerge(clsx(inputs));
}

function getErrorMessage(err: unknown, fallback = 'Unknown error'): string {
  if (err instanceof Error) return err.message || fallback;
  if (err && typeof err === 'object') {
    const maybeError = (err as { error?: unknown; message?: unknown }).error;
    if (typeof maybeError === 'string' && maybeError.trim()) return maybeError;
    const maybeMessage = (err as { error?: unknown; message?: unknown }).message;
    if (typeof maybeMessage === 'string' && maybeMessage.trim()) return maybeMessage;
  }
  return fallback;
}

/* ─── helpers ─── */

function sessionStatusDot(status: string | undefined | null): string {
  switch (status) {
    case 'active':
    case 'running':
      return 'status-dot active';
    case 'exited':
    case 'terminated':
    case 'error':
      return 'status-dot danger';
    case 'idle':
    case 'waiting':
      return 'status-dot warning';
    default:
      return 'status-dot idle';
  }
}

function sessionStatusLabel(status: string | undefined | null): string {
  if (!status) return 'Unknown';
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function formatTime(ts?: string | number | null): string {
  if (!ts) return '';
  const d = new Date(typeof ts === 'number' ? ts : ts);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function cliTypeBadgeColor(cliType: string | null): string {
  switch (cliType) {
    case 'codex':
      return 'bg-[var(--color-accent-dim)] text-[var(--color-accent)]';
    case 'claude':
      return 'bg-[rgba(245,166,35,0.12)] text-[var(--color-warning)]';
    case 'gemini':
      return 'bg-[rgba(100,149,237,0.15)] text-[#6495ED]';
    case 'opencode':
      return 'bg-[rgba(124,58,237,0.15)] text-[#a78bfa]';
    default:
      return 'bg-[var(--color-bg)] text-[var(--color-text-secondary)]';
  }
}

function appendStreamingText(prev: string, next: string): string {
  const left = String(prev || '');
  const right = String(next || '');
  if (!right) return left;
  if (!left) return right;
  if (right.startsWith(left)) return right;
  if (left.endsWith(right)) return left;
  return `${left}${right}`;
}

function sanitizeTerminalText(input: string): string {
  if (!input) return '';
  return String(input)
    // OSC sequences
    .replace(/\u001B\][^\u0007]*(\u0007|\u001B\\)/g, '')
    // CSI / ANSI escape codes
    .replace(/\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '')
    // Keep line breaks and tabs, drop other control chars
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trimEnd();
}

const MODEL_OPTIONS: Record<string, string[]> = {
  claude: ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-opus-4-7', 'claude-haiku-4-5'],
  gemini: ['gemini-3-pro-preview', 'gemini-3.1-pro-preview', 'gemini-3-flash-preview'],
};

/* ─── Chat Bubble ─── */

function ChatBubble({ item }: { item: SessionHistoryItem }) {
  if (item.role === 'system') {
    return (
      <div className="flex justify-center py-1 animate-fade-in-up">
        <div className="text-[11px] italic text-[var(--color-text-secondary)] px-3 py-1 max-w-lg text-center">
          {item.content}
        </div>
      </div>
    );
  }

  const isAssistant = item.role === 'assistant';

  return (
    <div
      className={cn(
        'flex animate-fade-in-up',
        isAssistant ? 'justify-start' : 'justify-end'
      )}
    >
      <div
        className={cn(
          'max-w-[80%] rounded-lg px-3 py-2',
          isAssistant
            ? 'bg-[var(--color-bg-panel)] border border-[var(--color-border)]'
            : 'bg-[rgba(245,166,35,0.08)] border border-[rgba(245,166,35,0.2)]'
        )}
      >
        {/* Role label */}
        <div
          className={cn(
            'text-[9px] font-heading font-bold uppercase tracking-widest mb-1',
            isAssistant
              ? 'text-[var(--color-accent)]'
              : 'text-[var(--color-warning)]'
          )}
        >
          {isAssistant ? 'AI' : 'YOU'}
        </div>
        {/* Content */}
        <div
          className={cn(
            'text-sm whitespace-pre-wrap break-words mono-log',
            isAssistant
              ? 'text-[var(--color-accent)]'
              : 'text-[var(--color-warning)]'
          )}
        >
          {item.content}
        </div>
        {/* Timestamp */}
        {item.timestamp && (
          <div className="text-[9px] text-[var(--color-text-secondary)] mt-1 text-right">
            {formatTime(item.timestamp)}
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── New Session Modal ─── */

function NewSessionModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (session: Session) => void;
}) {
  const [cliType, setCliType] = useState<string>('codex');
  const [model, setModel] = useState<string>('');
  const [sessionId, setSessionId] = useState('');
  const [workspacePath, setWorkspacePath] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const list = MODEL_OPTIONS[cliType] || [];
    if (list.length > 0) {
      setModel(list[0]);
    } else {
      setModel('');
    }
  }, [cliType]);

  const handleSubmit = useCallback(async () => {
    setSubmitting(true);
    setError(null);
    try {
      const payload: CreateSessionPayload = {
        cliType,
        options: {
          ...((cliType === 'claude' || cliType === 'gemini') ? { transport: 'acpx' } : {}),
          ...((cliType === 'claude' || cliType === 'gemini') && model ? { model } : {}),
          ...(workspacePath.trim() ? { cwd: workspacePath.trim() } : {}),
        },
      };
      if (sessionId.trim()) payload.id = sessionId.trim();

      const res = await sessionApi.create(payload);
      if (res.ok && res.session) {
        onCreated(res.session);
        setCliType('codex');
        setSessionId('');
        setWorkspacePath('');
        setModel('');
        onClose();
      } else {
        setError(res.error || 'Failed to create session');
      }
    } catch (err: unknown) {
      setError(getErrorMessage(err, 'Unknown error'));
    } finally {
      setSubmitting(false);
    }
  }, [cliType, model, sessionId, workspacePath, onCreated, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 animate-fade-in-up">
      <div className="panel rounded-lg w-full max-w-md mx-4 p-6 space-y-4 animate-fade-in-up">
        <h2 className="text-sm font-heading font-semibold text-[var(--color-text-primary)] tracking-wide">
          NEW ACPX SESSION
        </h2>

        <div>
          <label className="block text-xs text-[var(--color-text-secondary)] mb-1">
            Runtime
          </label>
          <select
            className="w-full rounded px-3 py-2 text-sm"
            value={cliType}
            onChange={(e) => setCliType(e.target.value)}
          >
            <option value="codex">codex</option>
            <option value="claude">claude</option>
            <option value="gemini">gemini</option>
            <option value="opencode">opencode</option>
          </select>
        </div>

        {(cliType === 'claude' || cliType === 'gemini') && (
          <div>
            <label className="block text-xs text-[var(--color-text-secondary)] mb-1">
              Model
            </label>
            <select
              className="w-full rounded px-3 py-2 text-sm"
              value={model}
              onChange={(e) => setModel(e.target.value)}
            >
              {(MODEL_OPTIONS[cliType] || []).map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </div>
        )}

        <div>
          <label className="block text-xs text-[var(--color-text-secondary)] mb-1">
            Session Key / ID
          </label>
          <input
            className="w-full rounded px-3 py-2 text-sm"
            placeholder="optional — auto-generated if empty"
            value={sessionId}
            onChange={(e) => setSessionId(e.target.value)}
          />
        </div>

        <div>
          <label className="block text-xs text-[var(--color-text-secondary)] mb-1">
            Workspace Path (Local Fallback)
          </label>
          <input
            className="w-full rounded px-3 py-2 text-sm"
            placeholder="optional — defaults to .workspaces/<cliType>/<sessionId>"
            value={workspacePath}
            onChange={(e) => setWorkspacePath(e.target.value)}
          />
        </div>

        {error && (
          <div className="text-xs text-[var(--color-danger)] flex items-center gap-1">
            <AlertTriangle size={12} />
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button
            className="px-4 py-2 text-xs rounded border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className={cn(
              'px-4 py-2 text-xs rounded bg-[var(--color-accent)] text-[var(--color-bg)] font-semibold',
              'hover:opacity-90 transition-opacity',
              submitting && 'opacity-50 cursor-not-allowed'
            )}
            disabled={submitting}
            onClick={handleSubmit}
          >
            {submitting ? (
              <Loader2 size={14} className="animate-spin inline" />
            ) : (
            <Plus size={14} className="inline" />
            )}{' '}
            Create
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─── Dispatch Dropdown ─── */

const DISPATCH_OPTIONS: Array<{
  label: string;
  payload: Record<string, unknown>;
}> = [
  { label: 'Help (/help)', payload: { message: '/help', target: 'local' } },
  { label: 'Reset (/reset)', payload: { message: '/reset', target: 'local' } },
  { label: 'Interrupt (Ctrl+C)', payload: { message: '\u0003', target: 'local' } },
  {
    label: 'Mirror to OpenClaw',
    payload: { message: 'mirror latest context', target: 'openclaw', openclawMode: 'mirror' },
  },
];

function DispatchDropdown({
  sessionId,
  onDispatched,
}: {
  sessionId: string;
  onDispatched: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [dispatching, setDispatching] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const handleDispatch = useCallback(
    async (payload: Record<string, unknown>) => {
      setOpen(false);
      setDispatching(true);
      try {
        await sessionApi.dispatch(sessionId, payload);
        onDispatched();
      } catch {
        // ignore
      } finally {
        setDispatching(false);
      }
    },
    [sessionId, onDispatched]
  );

  return (
    <div ref={ref} className="relative">
      <button
        className={cn(
          'flex items-center gap-1 px-2.5 py-2 rounded text-xs border border-[var(--color-border)]',
          'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:border-[var(--color-accent)] transition-colors',
          dispatching && 'opacity-50 cursor-not-allowed'
        )}
        disabled={dispatching}
        onClick={() => setOpen((v) => !v)}
      >
        {dispatching ? (
          <Loader2 size={12} className="animate-spin" />
        ) : (
          <RotateCcw size={12} strokeWidth={1.5} />
        )}
        <span className="hidden sm:inline">DISPATCH</span>
        <ChevronDown size={10} strokeWidth={1.5} />
      </button>
      {open && (
        <div className="absolute bottom-full left-0 mb-1 w-32 z-20 panel rounded py-1 animate-fade-in-up">
          {DISPATCH_OPTIONS.map((opt) => (
            <button
              key={opt.label}
              className="w-full text-left px-3 py-1.5 text-xs text-[var(--color-text-primary)] hover:bg-[var(--color-accent-dim)] transition-colors"
              onClick={() => handleDispatch(opt.payload)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ─── Main Component ─── */

export default function Sessions() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedSession, setSelectedSession] = useState<Session | null>(null);
  const [history, setHistory] = useState<SessionHistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [inputMsg, setInputMsg] = useState('');
  const [sending, setSending] = useState(false);
  const [awaitingAssistant, setAwaitingAssistant] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const chatEndRef = useRef<HTMLDivElement>(null);
  const lastProcessedWsIndexRef = useRef(-1);
  const lastSessionExitRefreshRef = useRef<{ sessionId: string; at: number } | null>(null);

  /* ── WebSocket ── */
  const { messages: wsMessages } = useWsMessages(['session_output', 'session_message', 'session_exit']);

  /* ── Auto-scroll ── */
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [history.length]);

  /* ── Fetch session list ── */
  const fetchSessions = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await sessionApi.list();
      if (res.ok) {
        setSessions(res.sessions ?? []);
      } else {
        setError(res.error || 'Failed to load sessions');
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  /* ── Select session → load history + meta ── */
  const selectSession = useCallback(
    async (id: string) => {
      setSelectedId(id);
      setAwaitingAssistant(false);
      setHistoryLoading(true);
      try {
        const [historyRes, metaRes] = await Promise.allSettled([
          sessionApi.getHistory(id),
          sessionApi.getById(id),
        ]);

        if (metaRes.status === 'fulfilled' && metaRes.value.ok && metaRes.value.session) {
          setSelectedSession(metaRes.value.session);
        } else {
          setSelectedSession((prev) => {
            if (prev?.id === id) return prev;
            const fallback = sessions.find((item) => item.id === id);
            return fallback || prev || null;
          });
        }

        if (historyRes.status === 'fulfilled' && historyRes.value.ok && historyRes.value.history) {
          setHistory(historyRes.value.history.map((item) => ({
            ...item,
            content: sanitizeTerminalText(String(item.content || '')),
          })));
        } else {
          // For newly created plain sessions there may be no orchestrator-bound history yet.
          setHistory([]);
        }
      } catch {
        setSelectedSession((prev) => {
          if (prev?.id === id) return prev;
          const fallback = sessions.find((item) => item.id === id);
          return fallback || prev || null;
        });
        setHistory([]);
      } finally {
        setHistoryLoading(false);
      }
    },
    [sessions]
  );

  const STREAMING_FALLBACK_ID = '__streaming_assistant__';

  const selectedSessionType = String(selectedSession?.cliType || '').toLowerCase();
  const selectedSessionTransport = String(selectedSession?.transport || '').toLowerCase();
  const isStructuredCodex = selectedSessionType === 'codex' && selectedSessionTransport === 'structured';

  const applySessionMessage = useCallback((prev: SessionHistoryItem[], latest: WsMessage): SessionHistoryItem[] => {
    if (latest.type !== 'session_message') return prev;
    const raw = latest.message;
    if (!raw || typeof raw === 'string') return prev;

    const role = raw.role === 'user' || raw.role === 'assistant' || raw.role === 'system'
      ? raw.role
      : 'system';
    const content = sanitizeTerminalText(String(raw.text || '').trim());
    if (!content) return prev;

    const nextItem: SessionHistoryItem = {
      id: raw.id,
      role,
      content,
      timestamp: raw.updatedAt || raw.createdAt || latest.timestamp || Date.now(),
      status: raw.status,
      source: raw.source,
      turnId: raw.turnId ?? null,
    };

    const withoutFallback = prev.filter((item) => item.id !== STREAMING_FALLBACK_ID);

    // 1) Prefer hard upsert by backend message id
    const idxById = raw.id ? withoutFallback.findIndex((item) => item.id === raw.id) : -1;
    if (idxById >= 0) {
      const cloned = [...withoutFallback];
      cloned[idxById] = { ...cloned[idxById], ...nextItem };
      return cloned;
    }

    // 2) For update events without id, update the latest same-role bubble in place
    if (latest.update) {
      const idxByRole = [...withoutFallback]
        .map((item, idx) => ({ item, idx }))
        .reverse()
        .find(({ item }) => item.role === role)
        ?.idx;

      if (typeof idxByRole === 'number') {
        const cloned = [...withoutFallback];
        const existing = cloned[idxByRole];
        cloned[idxByRole] = {
          ...existing,
          ...nextItem,
          id: existing.id || nextItem.id,
          content,
        };
        return cloned;
      }
    }

    // 3) Soft dedupe for repeated identical payloads
    const last = withoutFallback[withoutFallback.length - 1];
    if (last && last.role === role && String(last.content || '').trim() === content) {
      return withoutFallback;
    }

    // 4) Stronger dedupe: if same role+content already exists in recent history, drop it
    const duplicatedInRecent = withoutFallback
      .slice(Math.max(0, withoutFallback.length - 20))
      .some((item) => item.role === role && String(item.content || '').trim() === content);
    if (duplicatedInRecent) {
      return withoutFallback;
    }

    return [...withoutFallback, nextItem];
  }, []);

  /* ── WS: real-time session output ── */
  useEffect(() => {
    if (wsMessages.length === 0) return;

    for (let index = Math.max(0, lastProcessedWsIndexRef.current + 1); index < wsMessages.length; index += 1) {
      const latest = wsMessages[index];
      lastProcessedWsIndexRef.current = index;

      if (latest.type === 'session_message' && latest.sessionId === selectedId) {
        setHistory((prev) => applySessionMessage(prev, latest));
        const raw = latest.message;
        if (raw && typeof raw !== 'string') {
          const role = String(raw.role || '').toLowerCase();
          if (role === 'assistant' || role === 'system') {
            setAwaitingAssistant(false);
          }
        }
      }

      if (!isStructuredCodex && latest.type === 'session_output' && latest.sessionId === selectedId && latest.data) {
        setAwaitingAssistant(false);
        setHistory((prev) => {
          const text = sanitizeTerminalText(String(latest.data || '').trim());
          if (!text) return prev;
          const lastIndex = prev.length - 1;
          if (lastIndex >= 0 && prev[lastIndex]?.id === STREAMING_FALLBACK_ID) {
            const cloned = [...prev];
            cloned[lastIndex] = {
              ...cloned[lastIndex],
              content: appendStreamingText(cloned[lastIndex].content, text),
              timestamp: latest.timestamp ?? Date.now(),
            };
            return cloned;
          }
          return [
            ...prev,
            {
              id: STREAMING_FALLBACK_ID,
              role: 'assistant',
              content: text,
              timestamp: latest.timestamp ?? Date.now(),
            },
          ];
        });
      }

      if (latest.type === 'session_exit') {
        const now = Date.now();
        const lastExit = lastSessionExitRefreshRef.current;
        if (!lastExit || lastExit.sessionId !== latest.sessionId || (now - lastExit.at) > 3000) {
          lastSessionExitRefreshRef.current = { sessionId: latest.sessionId || '', at: now };
          fetchSessions();
          if (latest.sessionId === selectedId) {
            sessionApi.getById(selectedId).then((res) => {
              if (res.ok && res.session) setSelectedSession(res.session);
            });
          }
        }
      }
    }
  }, [wsMessages, selectedId, fetchSessions, applySessionMessage, isStructuredCodex]);

  /* ── Send input ── */
  const handleSendInput = useCallback(async () => {
    if (!selectedId || !inputMsg.trim() || sending) return;
    const msg = inputMsg.trim();
    setSending(true);
    setAwaitingAssistant(true);
    setInputMsg('');

    // Optimistically add user message
    setHistory((prev) => [
      ...prev,
      { role: 'user', content: msg, timestamp: Date.now() },
    ]);

    try {
      await sessionApi.sendInput(selectedId, { message: msg });
    } catch {
      // ignore — WS may still deliver output
      setAwaitingAssistant(false);
    } finally {
      setSending(false);
    }
  }, [selectedId, inputMsg, sending]);

  /* ── After dispatch ── */
  const handleDispatched = useCallback(() => {
    if (!selectedId) return;
    sessionApi.getHistory(selectedId).then((res) => {
      if (res.ok && res.history) setHistory(res.history);
    });
  }, [selectedId]);

  const handleDeleteSession = useCallback(async (sessionId: string) => {
    if (!sessionId || deletingId) return;
    const confirmed = window.confirm(`Delete session "${sessionId}"? This cannot be undone.`);
    if (!confirmed) return;

    setDeletingId(sessionId);
    try {
      const res = await sessionApi.remove(sessionId);
      if (!res.ok) return;

      setSessions((prev) => prev.filter((s) => s.id !== sessionId));
      if (selectedId === sessionId) {
        setSelectedId(null);
        setSelectedSession(null);
        setHistory([]);
      }
    } catch {
      // ignore
    } finally {
      setDeletingId(null);
    }
  }, [deletingId, selectedId]);

  /* ─── RENDER ─── */

  return (
    <div className="flex h-full min-h-0">
      {/* ── Left panel ── */}
      <div className="w-[280px] shrink-0 border-r border-[var(--color-border)] flex flex-col bg-[var(--color-bg-panel)]">
        {/* New session button */}
        <div className="px-3 py-3 border-b border-[var(--color-border)]">
          <button
            className="flex items-center justify-center gap-1.5 w-full px-3 py-2 rounded text-xs bg-[var(--color-accent)] text-[var(--color-bg)] font-semibold hover:opacity-90 transition-opacity"
            onClick={() => setShowCreate(true)}
          >
            <Plus size={14} strokeWidth={1.5} />
            NEW ACPX SESSION
          </button>
        </div>

        {/* Session list */}
        <div className="flex-1 overflow-y-auto">
          {loading && sessions.length === 0 ? (
            <div className="flex items-center justify-center h-32 text-[var(--color-text-secondary)] text-xs animate-pulse">
              Loading sessions...
            </div>
          ) : error && sessions.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-32 text-[var(--color-danger)] text-xs gap-1">
              <AlertTriangle size={16} />
              {error}
            </div>
          ) : sessions.length === 0 ? (
            <div className="flex items-center justify-center h-32 text-[var(--color-text-secondary)] text-xs">
              No sessions
            </div>
          ) : (
            <div className="divide-y divide-[var(--color-border)]">
              {sessions.map((session, i) => (
                <div
                  key={session.id || `session-${i}`}
                  className={cn(
                    'w-full px-3 py-2.5 flex items-start gap-2.5 transition-colors',
                    'hover:bg-[var(--color-accent-dim)]'
                  )}
                >
                  <button
                    className="flex items-start gap-2.5 flex-1 min-w-0 text-left"
                    onClick={() => selectSession(session.id)}
                  >
                  <span
                    className={sessionStatusDot(session.status)}
                    style={{ marginTop: 5 }}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-semibold text-[var(--color-text-primary)] truncate font-heading">
                      {session.id}
                    </div>
                    <div className="flex items-center gap-1.5 mt-1">
                      {session.cliType && (
                        <span
                          className={cn(
                            'text-[9px] font-semibold px-1.5 py-0.5 rounded',
                            cliTypeBadgeColor(session.cliType)
                          )}
                        >
                          {session.cliType}
                        </span>
                      )}
                      <span className="text-[10px] text-[var(--color-text-secondary)]">
                        {sessionStatusLabel(session.status)}
                      </span>
                      <span className="text-[10px] text-[var(--color-text-secondary)]">
                        {String(session.transport || 'local-cli')}
                      </span>
                    </div>
                  </div>
                  </button>

                  <button
                    className={cn(
                      'shrink-0 p-1.5 rounded border border-transparent text-[var(--color-text-secondary)]',
                      'hover:text-[var(--color-danger)] hover:border-[var(--color-danger)] transition-colors',
                      deletingId === session.id && 'opacity-50 cursor-not-allowed'
                    )}
                    title="Delete session"
                    disabled={deletingId === session.id}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteSession(session.id);
                    }}
                  >
                    {deletingId === session.id ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <Trash2 size={12} strokeWidth={1.5} />
                    )}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── Right panel ── */}
      <div className="flex-1 flex flex-col min-w-0 bg-[var(--color-bg)]">
        {!selectedSession ? (
          /* Empty state */
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center space-y-2">
              <MessageSquare
                size={32}
                strokeWidth={1}
                className="mx-auto text-[var(--color-text-secondary)] opacity-30"
              />
              <div className="text-[var(--color-text-secondary)] text-sm">
                Select a session to interact with ACPX CLI
              </div>
            </div>
          </div>
        ) : (
          <>
            {/* Header */}
            <div className="px-5 py-3 border-b border-[var(--color-border)] bg-[var(--color-bg-panel)] shrink-0">
              <div className="flex items-center gap-3">
                <h2 className="text-sm font-heading font-semibold text-[var(--color-text-primary)] tracking-wide truncate">
                  {selectedSession.id}
                </h2>
                {selectedSession.cliType && (
                  <span
                    className={cn(
                      'text-[9px] font-semibold px-1.5 py-0.5 rounded',
                      cliTypeBadgeColor(selectedSession.cliType)
                    )}
                  >
                    {selectedSession.cliType}
                  </span>
                )}
                <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded bg-[var(--color-bg)] text-[var(--color-text-secondary)]">
                  {String(selectedSession.transport || 'local-cli')}
                </span>
                <span
                  className={cn(
                    'text-[9px] font-semibold px-2 py-0.5 rounded-full uppercase tracking-wider',
                    selectedSession.status === 'active' || selectedSession.status === 'running'
                      ? 'bg-[var(--color-accent-dim)] text-[var(--color-accent)]'
                      : selectedSession.status === 'exited' || selectedSession.status === 'error'
                        ? 'bg-[rgba(255,69,69,0.12)] text-[var(--color-danger)]'
                        : 'bg-[var(--color-bg)] text-[var(--color-text-secondary)]'
                  )}
                >
                  {selectedSession.status}
                </span>
              </div>
            </div>

            {/* Chat messages */}
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
              {historyLoading ? (
                <div className="flex items-center justify-center h-24 text-[var(--color-text-secondary)] text-xs animate-pulse">
                  <Loader2 size={16} className="animate-spin mr-2" />
                  Loading history...
                </div>
              ) : history.length === 0 ? (
                <div className="flex items-center justify-center h-24 text-[var(--color-text-secondary)] text-xs">
                  No messages yet
                </div>
              ) : (
                history.map((item, i) => (
                  <ChatBubble key={item.id || `${item.role}-${i}`} item={item} />
                ))
              )}
              <div ref={chatEndRef} />
            </div>

            {/* Bottom bar: Dispatch + Input + Send */}
            <div className="px-5 py-3 border-t border-[var(--color-border)] bg-[var(--color-bg-panel)] shrink-0">
              {awaitingAssistant && (
                <div className="mb-2 flex items-center gap-2 text-[11px] text-[var(--color-text-secondary)]">
                  <Loader2 size={12} className="animate-spin" />
                  Thinking...
                </div>
              )}
              <div className="flex items-center gap-2">
                {/* Dispatch dropdown */}
                <DispatchDropdown
                  sessionId={selectedSession.id}
                  onDispatched={handleDispatched}
                />

                {/* Input */}
                <input
                  className="flex-1 rounded px-3 py-2 text-sm"
                  placeholder="Send input to CLI session..."
                  value={inputMsg}
                  onChange={(e) => setInputMsg(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      handleSendInput();
                    }
                  }}
                />

                {/* Send */}
                <button
                  className={cn(
                    'flex items-center gap-1 px-3 py-2 rounded text-xs font-semibold bg-[var(--color-accent)] text-[var(--color-bg)]',
                    'hover:opacity-90 transition-opacity',
                    (!inputMsg.trim() || sending) && 'opacity-50 cursor-not-allowed'
                  )}
                  disabled={!inputMsg.trim() || sending}
                  onClick={handleSendInput}
                >
                  {sending ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <Send size={14} strokeWidth={1.5} />
                  )}
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      {/* New session modal */}
      <NewSessionModal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        onCreated={(session) => {
          setSessions((prev) => [session, ...prev]);
          selectSession(session.id);
        }}
      />
    </div>
  );
}
