import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  Plus,
  Pause,
  Play,
  Square,
  ChevronDown,
  ChevronUp,
  Search,
  Send,
  Loader2,
  AlertTriangle,
  CheckCircle,
  XCircle,
  Clock,
  X,
} from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { acpApi } from '../api';
import { useWsMessages } from '../useWebSocket';
import type {
  Task,
  TaskStatus,
  Runtime,
  CreateTaskPayload,
  SendInputPayload,
} from '../types';
import { wsMessageText } from '../types';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/* ── Status helpers ────────────────────────────────────── */

const STATUS_TABS = ['ALL', 'running', 'paused', 'completed', 'failed'] as const;
type StatusTab = (typeof STATUS_TABS)[number];

function statusDotClass(status: TaskStatus | undefined | null): string {
  switch (status) {
    case 'running':
    case 'submitted':
    case 'queued':
      return 'status-dot active';
    case 'paused':
      return 'status-dot warning';
    case 'completed':
      return 'status-dot active';
    case 'failed':
    case 'terminated':
      return 'status-dot danger';
    default:
      return 'status-dot idle';
  }
}

function statusLabel(status: TaskStatus | undefined | null): string {
  if (!status) return 'Unknown';
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function runtimeFromTask(task: Task): string {
  if (task.metadata?.runtime) return String(task.metadata.runtime);
  if (task.agentId) return task.agentId;
  return '—';
}

function formatTimestamp(ts?: string | number | null): string {
  if (!ts) return '—';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function dedupeTasksById(list: Task[]): Task[] {
  const map = new Map<string, Task>();
  for (const item of list) {
    if (!item?.id) continue;
    map.set(item.id, item);
  }
  return Array.from(map.values()).sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
}

/* ── Component ──────────────────────────────────────── */

const MODEL_OPTIONS: Record<string, string[]> = {
  codex: [],
  claude: ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-opus-4-7', 'claude-haiku-4-5'],
  gemini: ['gemini-3-pro-preview', 'gemini-3.1-pro-preview', 'gemini-3-flash-preview'],
  opencode: [],
  openclaw: [],
};

export default function AcpRuns() {
  /* ── State ── */
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<StatusTab>('ALL');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // New run form
  const [showNewRun, setShowNewRun] = useState(false);
  const [newPrompt, setNewPrompt] = useState('');
  const [newRuntime, setNewRuntime] = useState<Runtime>('codex');
  const [newModel, setNewModel] = useState<string>('');
  const [newSessionKey, setNewSessionKey] = useState('');
  const [newAgentId, setNewAgentId] = useState('');
  const [newThreadId, setNewThreadId] = useState('');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    const list = MODEL_OPTIONS[newRuntime] || [];
    if (list.length > 0) {
      setNewModel(list[0]);
    } else {
      setNewModel('');
    }
  }, [newRuntime]);

  // Send input
  const [inputText, setInputText] = useState('');
  const [sendingInput, setSendingInput] = useState(false);

  // Control actions
  const [controlLoading, setControlLoading] = useState<Record<string, boolean>>({});

  // Session drawer
  const [sessionKeySearch, setSessionKeySearch] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerData, setDrawerData] = useState<{
    sessionKey: string;
    activeRun: unknown | null;
    runs: unknown[];
  } | null>(null);
  const [drawerLoading, setDrawerLoading] = useState(false);

  // Action feedback
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  // WS
  const wsEventTypes = useMemo(
    () => ['run_event', 'task_updated', 'task_submitted', 'task_added', 'task_terminated', 'task_submission_result'],
    [],
  );
  const { messages: wsMessages } = useWsMessages(wsEventTypes);
  const lastHandledWsRef = useRef<string>('');

  const inputRef = useRef<HTMLInputElement>(null);

  /* ── Fetch runs ── */
  const fetchRuns = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await acpApi.listRuns();
      if (res.ok && res.tasks) {
        setTasks(dedupeTasksById(res.tasks));
      } else {
        setError(res.error || 'Failed to fetch runs');
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchRuns();
  }, [fetchRuns]);

  /* ── WS: update runs on events ── */
  useEffect(() => {
    if (wsMessages.length === 0) return;
    const latest = wsMessages[wsMessages.length - 1];
    const latestTaskId = latest.task?.id || '';
    const latestRunTaskId = latest.run?.taskId || '';
    const wsKey = `${wsMessages.length}:${latest.type}:${latestTaskId}:${latestRunTaskId}:${latest.timestamp || ''}`;
    if (lastHandledWsRef.current === wsKey) return;
    lastHandledWsRef.current = wsKey;
    if (latest.task) {
      setTasks((prev) => {
        const idx = prev.findIndex((t) => t.id === latest.task!.id);
        if (idx >= 0) {
          const current = prev[idx];
          const nextTask = latest.task!;
          if (
            current.status === nextTask.status &&
            current.controlState === nextTask.controlState &&
            current.updatedAt === nextTask.updatedAt &&
            current.answerText === nextTask.answerText &&
            current.error === nextTask.error
          ) {
            return prev;
          }
          const updated = [...prev];
          updated[idx] = nextTask;
          return updated;
        }
        return dedupeTasksById([latest.task!, ...prev]);
      });
    }
    if (latest.run) {
      setTasks((prev) => {
        const idx = prev.findIndex((t) => t.id === latest.run!.taskId);
        if (idx >= 0) {
          const updated = [...prev];
          updated[idx] = { ...updated[idx], controlState: latest.run!.controlState, status: latest.run!.status, answerText: latest.run!.answerText, error: latest.run!.error };
          return updated;
        }
        return prev;
      });
    }
  }, [wsMessages.length]);

  /* ── Filtered tasks ── */
  const filtered = activeTab === 'ALL' ? tasks : tasks.filter((t) => t.status === activeTab);

  /* ── Toast helper ── */
  const showToast = useCallback((message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  }, []);

  /* ── Control actions ── */
  const handlePause = useCallback(async (id: string) => {
    setControlLoading((p) => ({ ...p, [id]: true }));
    try {
      const res = await acpApi.pause(id);
      if (res.ok && res.task) {
        setTasks((prev) => prev.map((t) => (t.id === id ? res.task! : t)));
        showToast('Run paused');
      } else {
        if ((res as { code?: string }).code === 'TASK_NOT_PAUSABLE') {
          const latest = await acpApi.getRun(id);
          if (latest.ok && latest.task) {
            setTasks((prev) => prev.map((t) => (t.id === id ? latest.task! : t)));
          }
          showToast('Run is not pausable in current state', 'error');
        } else {
          showToast(res.error || 'Pause failed', 'error');
        }
      }
    } catch (err) {
      const e = err as { error?: string; code?: string };
      if (e?.code === 'TASK_NOT_PAUSABLE') {
        try {
          const latest = await acpApi.getRun(id);
          if (latest.ok && latest.task) {
            setTasks((prev) => prev.map((t) => (t.id === id ? latest.task! : t)));
          }
        } catch {
          // ignore
        }
        showToast('Run is not pausable in current state', 'error');
      } else {
        showToast(err instanceof Error ? err.message : (e?.error || 'Pause failed'), 'error');
      }
    } finally {
      setControlLoading((p) => ({ ...p, [id]: false }));
    }
  }, [showToast]);

  const handleResume = useCallback(async (id: string) => {
    setControlLoading((p) => ({ ...p, [id]: true }));
    try {
      const res = await acpApi.resume(id);
      if (res.ok && res.task) {
        setTasks((prev) => prev.map((t) => (t.id === id ? res.task! : t)));
        showToast('Run resumed');
      } else {
        showToast(res.error || 'Resume failed', 'error');
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Resume failed', 'error');
    } finally {
      setControlLoading((p) => ({ ...p, [id]: false }));
    }
  }, [showToast]);

  const handleTerminate = useCallback(async (id: string) => {
    setControlLoading((p) => ({ ...p, [id]: true }));
    try {
      const res = await acpApi.terminate(id);
      if (res.ok && res.task) {
        setTasks((prev) => prev.map((t) => (t.id === id ? res.task! : t)));
        showToast('Run terminated');
      } else {
        showToast(res.error || 'Terminate failed', 'error');
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Terminate failed', 'error');
    } finally {
      setControlLoading((p) => ({ ...p, [id]: false }));
    }
  }, [showToast]);

  /* ── Create run ── */
  const handleCreateRun = useCallback(async () => {
    if (!newPrompt.trim()) return;
    setCreating(true);
    try {
      const payload: CreateTaskPayload = {
        prompt: newPrompt.trim(),
        runtime: newRuntime,
        metadata: (newRuntime === 'claude' || newRuntime === 'gemini') && newModel ? { model: newModel } : undefined,
      };
      if (newSessionKey.trim()) payload.sessionKey = newSessionKey.trim();
      if (newAgentId.trim()) payload.agentId = newAgentId.trim();
      if (newThreadId.trim()) payload.threadId = newThreadId.trim();

      const res = await acpApi.createRun(payload);
      if (res.ok) {
        showToast('Run created');
        setShowNewRun(false);
        setNewPrompt('');
        setNewRuntime('codex');
        setNewModel('');
        setNewSessionKey('');
        setNewAgentId('');
        setNewThreadId('');
        fetchRuns();
      } else {
        showToast(res.error || 'Create failed', 'error');
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Create failed', 'error');
    } finally {
      setCreating(false);
    }
  }, [newPrompt, newRuntime, newSessionKey, newAgentId, newThreadId, showToast, fetchRuns]);

  /* ── Send input ── */
  const handleSendInput = useCallback(async () => {
    if (!expandedId || !inputText.trim()) return;
    setSendingInput(true);
    try {
      const res = await acpApi.sendInput(expandedId, { message: inputText.trim() } as SendInputPayload);
      if (res.ok) {
        showToast('Input sent');
        setInputText('');
      } else {
        showToast(res.error || 'Send failed', 'error');
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Send failed', 'error');
    } finally {
      setSendingInput(false);
    }
  }, [expandedId, inputText, showToast]);

  /* ── Session search ── */
  const handleSessionSearch = useCallback(async () => {
    if (!sessionKeySearch.trim()) return;
    setDrawerLoading(true);
    setDrawerOpen(true);
    try {
      const res = await acpApi.getSession(sessionKeySearch.trim());
      if (res.ok && res.session) {
        setDrawerData(res.session);
      } else {
        setDrawerData(null);
        showToast(res.error || 'Session not found', 'error');
      }
    } catch (err) {
      setDrawerData(null);
      showToast(err instanceof Error ? err.message : 'Search failed', 'error');
    } finally {
      setDrawerLoading(false);
    }
  }, [sessionKeySearch, showToast]);

  /* ── WS events for expanded run ── */
  const expandedWsEvents = expandedId
    ? wsMessages.filter((m) => {
        if (m.task?.id === expandedId) return true;
        if (m.run?.taskId === expandedId) return true;
        return false;
      })
    : [];

  /* ── Render ── */
  return (
    <div className="flex h-full relative">
      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0 p-5 gap-4 overflow-y-auto">
        {/* ── Top bar ── */}
        <div className="flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setShowNewRun(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-[var(--color-accent)] text-[var(--color-bg)] hover:opacity-90 transition-opacity"
            >
              <Plus size={14} strokeWidth={2} />
              NEW RUN
            </button>

            {/* Filter tabs */}
            <div className="flex items-center gap-0.5 ml-2">
              {STATUS_TABS.map((tab) => {
                const isActive = activeTab === tab;
                return (
                  <button
                    key={tab}
                    onClick={() => setActiveTab(tab)}
                    className={cn(
                      'px-2.5 py-1 text-[11px] font-medium tracking-wide transition-colors relative',
                      isActive
                        ? 'text-[var(--color-accent)]'
                        : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
                    )}
                  >
                    {tab === 'ALL' ? 'ALL' : tab.toUpperCase()}
                    {isActive && (
                      <span className="absolute bottom-0 left-1 right-1 h-[2px] rounded-t bg-[var(--color-accent)]" />
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="text-[11px] text-[var(--color-text-secondary)] font-mono">
            {filtered.length} run{filtered.length !== 1 ? 's' : ''}
          </div>
        </div>

        {/* ── New Run Form ── */}
        {showNewRun && (
          <div className="panel rounded-lg p-4 animate-fade-in-up shrink-0">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-heading font-semibold text-[var(--color-text-primary)]">
                Create New Run
              </h3>
              <button
                onClick={() => setShowNewRun(false)}
                className="text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors"
              >
                <X size={16} strokeWidth={1.5} />
              </button>
            </div>

            <div className="flex flex-col gap-3">
              <div>
                <label className="block text-[11px] text-[var(--color-text-secondary)] mb-1">
                  Prompt <span className="text-[var(--color-danger)]">*</span>
                </label>
                <textarea
                  value={newPrompt}
                  onChange={(e) => setNewPrompt(e.target.value)}
                  placeholder="Enter your prompt..."
                  rows={3}
                  className="w-full rounded-md px-3 py-2 text-sm resize-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] text-[var(--color-text-secondary)] mb-1">
                    Runtime
                  </label>
                  <select
                    value={newRuntime}
                    onChange={(e) => setNewRuntime(e.target.value as Runtime)}
                    className="w-full rounded-md px-3 py-1.5 text-sm"
                  >
                    <option value="codex">Codex</option>
                    <option value="claude">Claude</option>
                    <option value="gemini">Gemini</option>
                    <option value="opencode">OpenCode</option>
                    <option value="openclaw">OpenClaw</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[11px] text-[var(--color-text-secondary)] mb-1">
                    Model
                  </label>
                  <select
                    value={newModel}
                    onChange={(e) => setNewModel(e.target.value)}
                    className="w-full rounded-md px-3 py-1.5 text-sm"
                    disabled={(MODEL_OPTIONS[newRuntime] || []).length === 0}
                  >
                    {(MODEL_OPTIONS[newRuntime] || []).length === 0 ? (
                      <option value="">(default)</option>
                    ) : (
                      (MODEL_OPTIONS[newRuntime] || []).map((item) => (
                        <option key={item} value={item}>
                          {item}
                        </option>
                      ))
                    )}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] text-[var(--color-text-secondary)] mb-1">
                    Session Key
                  </label>
                  <input
                    value={newSessionKey}
                    onChange={(e) => setNewSessionKey(e.target.value)}
                    placeholder="optional"
                    className="w-full rounded-md px-3 py-1.5 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-[var(--color-text-secondary)] mb-1">
                    Agent ID
                  </label>
                  <input
                    value={newAgentId}
                    onChange={(e) => setNewAgentId(e.target.value)}
                    placeholder="optional"
                    className="w-full rounded-md px-3 py-1.5 text-sm"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] text-[var(--color-text-secondary)] mb-1">
                    Thread ID
                  </label>
                  <input
                    value={newThreadId}
                    onChange={(e) => setNewThreadId(e.target.value)}
                    placeholder="optional"
                    className="w-full rounded-md px-3 py-1.5 text-sm"
                  />
                </div>
              </div>

              <div className="flex justify-end gap-2 mt-1">
                <button
                  onClick={() => setShowNewRun(false)}
                  className="px-3 py-1.5 rounded-md text-xs text-[var(--color-text-secondary)] border border-[var(--color-border)] hover:text-[var(--color-text-primary)] transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleCreateRun}
                  disabled={creating || !newPrompt.trim()}
                  className={cn(
                    'flex items-center gap-1.5 px-4 py-1.5 rounded-md text-xs font-medium transition-opacity',
                    newPrompt.trim()
                      ? 'bg-[var(--color-accent)] text-[var(--color-bg)] hover:opacity-90'
                      : 'bg-[var(--color-border)] text-[var(--color-text-secondary)] cursor-not-allowed'
                  )}
                >
                  {creating ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                  {creating ? 'Creating...' : 'Submit'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── Run list ── */}
        <div className="flex-1 min-h-0">
          {loading ? (
            <div className="flex items-center justify-center h-40">
              <Loader2 size={24} className="animate-spin text-[var(--color-text-secondary)]" />
            </div>
          ) : error ? (
            <div className="flex items-center justify-center h-40 gap-2 text-[var(--color-danger)] text-sm">
              <AlertTriangle size={16} />
              {error}
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex items-center justify-center h-40 text-[var(--color-text-secondary)] text-sm">
              No runs found
            </div>
          ) : (
            <div className="flex flex-col gap-0.5">
              {filtered.map((task) => {
                const isExpanded = expandedId === task.id;
                const isLoading = controlLoading[task.id] ?? false;
                const isControllable =
                  task.controlState === 'running' || task.controlState === 'paused';

                return (
                  <div key={task.id} className="animate-fade-in-up">
                    {/* Row */}
                    <div
                      className={cn(
                        'panel rounded-md px-4 py-2.5 flex items-center gap-4 cursor-pointer transition-colors',
                        isExpanded && 'border-[var(--color-accent)] border-opacity-30',
                        'hover:border-[var(--color-accent)] hover:border-opacity-20'
                      )}
                      onClick={() => setExpandedId(isExpanded ? null : task.id)}
                    >
                      {/* Expand chevron */}
                      <span className="text-[var(--color-text-secondary)] shrink-0">
                        {isExpanded ? (
                          <ChevronUp size={14} strokeWidth={1.5} />
                        ) : (
                          <ChevronDown size={14} strokeWidth={1.5} />
                        )}
                      </span>

                      {/* Run ID */}
                      <span className="font-mono text-xs text-[var(--color-accent)] shrink-0 w-28 truncate">
                        {task.id ? task.id.slice(0, 16) : '—'}
                      </span>

                      {/* Status */}
                      <span className="flex items-center gap-1.5 shrink-0 w-28">
                        <span className={statusDotClass(task.status)} />
                        <span className="text-[11px] text-[var(--color-text-primary)]">
                          {statusLabel(task.status)}
                        </span>
                      </span>

                      {/* Runtime */}
                      <span className="text-[11px] text-[var(--color-text-secondary)] shrink-0 w-20 truncate uppercase tracking-wider font-mono">
                        {runtimeFromTask(task)}
                      </span>

                      {/* Timestamp */}
                      <span className="flex items-center gap-1 text-[11px] text-[var(--color-text-secondary)] shrink-0 w-20 font-mono">
                        <Clock size={11} strokeWidth={1.5} />
                        {formatTimestamp(task.submittedAt)}
                      </span>

                      {/* Spacer */}
                      <span className="flex-1" />

                      {/* Control buttons */}
                      <div className="flex items-center gap-1.5 shrink-0" onClick={(e) => e.stopPropagation()}>
                        {task.controlState === 'running' && (
                          <>
                            <button
                              onClick={() => handlePause(task.id)}
                              disabled={isLoading}
                              title="Pause"
                              className="p-1 rounded hover:bg-[var(--color-accent-dim)] text-[var(--color-warning)] transition-colors disabled:opacity-40"
                            >
                              {isLoading ? (
                                <Loader2 size={14} className="animate-spin" />
                              ) : (
                                <Pause size={14} strokeWidth={1.5} />
                              )}
                            </button>
                            <button
                              onClick={() => handleTerminate(task.id)}
                              disabled={isLoading}
                              title="Terminate"
                              className="p-1 rounded hover:bg-[var(--color-accent-dim)] text-[var(--color-danger)] transition-colors disabled:opacity-40"
                            >
                              <Square size={14} strokeWidth={1.5} />
                            </button>
                          </>
                        )}
                        {task.controlState === 'paused' && (
                          <>
                            <button
                              onClick={() => handleResume(task.id)}
                              disabled={isLoading}
                              title="Resume"
                              className="p-1 rounded hover:bg-[var(--color-accent-dim)] text-[var(--color-accent)] transition-colors disabled:opacity-40"
                            >
                              {isLoading ? (
                                <Loader2 size={14} className="animate-spin" />
                              ) : (
                                <Play size={14} strokeWidth={1.5} />
                              )}
                            </button>
                            <button
                              onClick={() => handleTerminate(task.id)}
                              disabled={isLoading}
                              title="Terminate"
                              className="p-1 rounded hover:bg-[var(--color-accent-dim)] text-[var(--color-danger)] transition-colors disabled:opacity-40"
                            >
                              <Square size={14} strokeWidth={1.5} />
                            </button>
                          </>
                        )}
                        {!isControllable && (
                          <span className="text-[11px] text-[var(--color-text-secondary)] px-2">
                            —
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Expanded detail */}
                    {isExpanded && (
                      <div className="panel rounded-b-md border-t-0 rounded-t-none px-4 py-3 ml-6 animate-fade-in-up">
                        {/* Prompt */}
                        <div className="mb-3">
                          <div className="text-[10px] uppercase tracking-wider text-[var(--color-text-secondary)] mb-1 font-heading">
                            Prompt
                          </div>
                          <pre className="mono-log whitespace-pre-wrap break-words bg-[var(--color-bg)] rounded px-3 py-2 text-[var(--color-text-primary)]">
                            {task.prompt}
                          </pre>
                        </div>

                        {/* Answer */}
                        {task.answerText && (
                          <div className="mb-3">
                            <div className="text-[10px] uppercase tracking-wider text-[var(--color-text-secondary)] mb-1 font-heading">
                              Answer
                            </div>
                            <pre className="mono-log whitespace-pre-wrap break-words bg-[var(--color-bg)] rounded px-3 py-2 text-[var(--color-accent)]">
                              {task.answerText}
                            </pre>
                          </div>
                        )}

                        {/* Error */}
                        {task.error && (
                          <div className="mb-3">
                            <div className="text-[10px] uppercase tracking-wider text-[var(--color-text-secondary)] mb-1 font-heading">
                              Error
                            </div>
                            <pre className="mono-log whitespace-pre-wrap break-words bg-[var(--color-bg)] rounded px-3 py-2 text-[var(--color-danger)]">
                              {task.error}
                            </pre>
                          </div>
                        )}

                        {/* WS Events */}
                        <div className="mb-3">
                          <div className="text-[10px] uppercase tracking-wider text-[var(--color-text-secondary)] mb-1 font-heading">
                            Live Events
                          </div>
                          <div className="bg-[var(--color-bg)] rounded px-3 py-2 max-h-32 overflow-y-auto mono-log">
                            {expandedWsEvents.length === 0 ? (
                              <span className="text-[var(--color-text-secondary)]">
                                No events yet...
                              </span>
                            ) : (
                              expandedWsEvents.map((ev, i) => (
                                <div key={i} className="flex gap-2 text-[11px]">
                                  <span className="text-[var(--color-text-secondary)] shrink-0">
                                    {formatTimestamp(ev.timestamp)}
                                  </span>
                                  <span className="text-[var(--color-accent)]">{ev.type}</span>
                                  {ev.message && (
                                    <span className="text-[var(--color-text-secondary)] truncate">
                                      {wsMessageText(ev.message)}
                                    </span>
                                  )}
                                  {ev.controlState && (
                                    <span className="text-[var(--color-warning)]">
                                      [{ev.controlState}]
                                    </span>
                                  )}
                                </div>
                              ))
                            )}
                          </div>
                        </div>

                        {/* Input field */}
                        {(task.controlState === 'running' || task.controlState === 'paused') && (
                          <div className="flex items-center gap-2">
                            <input
                              ref={inputRef}
                              value={inputText}
                              onChange={(e) => setInputText(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' && !e.shiftKey) handleSendInput();
                              }}
                              placeholder="Send input to this run..."
                              className="flex-1 rounded-md px-3 py-1.5 text-sm"
                            />
                            <button
                              onClick={handleSendInput}
                              disabled={sendingInput || !inputText.trim()}
                              className={cn(
                                'flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-medium transition-opacity',
                                inputText.trim()
                                  ? 'bg-[var(--color-accent)] text-[var(--color-bg)] hover:opacity-90'
                                  : 'bg-[var(--color-border)] text-[var(--color-text-secondary)] cursor-not-allowed'
                              )}
                            >
                              {sendingInput ? (
                                <Loader2 size={12} className="animate-spin" />
                              ) : (
                                <Send size={12} />
                              )}
                              Send
                            </button>
                          </div>
                        )}

                        {/* Metadata */}
                        {task.metadata && Object.keys(task.metadata).length > 0 && (
                          <div className="mt-3 text-[10px] text-[var(--color-text-secondary)]">
                            <span className="font-heading uppercase tracking-wider">Meta:</span>{' '}
                            {Object.entries(task.metadata).map(([k, v]) => (
                              <span key={k} className="mr-2">
                                <span className="text-[var(--color-text-primary)]">{k}</span>=
                                {String(v)}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* ── Session Key search bar ── */}
        <div className="shrink-0 flex items-center gap-2 pt-3 border-t border-[var(--color-border)]">
          <Search size={14} strokeWidth={1.5} className="text-[var(--color-text-secondary)]" />
          <input
            value={sessionKeySearch}
            onChange={(e) => setSessionKeySearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSessionSearch();
            }}
            placeholder="Session key..."
            className="flex-1 rounded-md px-3 py-1.5 text-sm"
          />
          <button
            onClick={handleSessionSearch}
            disabled={!sessionKeySearch.trim() || drawerLoading}
            className={cn(
              'flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-medium transition-opacity',
              sessionKeySearch.trim()
                ? 'bg-[var(--color-accent)] text-[var(--color-bg)] hover:opacity-90'
                : 'bg-[var(--color-border)] text-[var(--color-text-secondary)] cursor-not-allowed'
            )}
          >
            {drawerLoading ? <Loader2 size={12} className="animate-spin" /> : <Search size={12} />}
            Search
          </button>
        </div>
      </div>

      {/* ── Session Drawer (right side) ── */}
      <div
        className={cn(
          'h-full border-l border-[var(--color-border)] bg-[var(--color-bg-panel)] transition-transform duration-300 ease-in-out flex flex-col',
          drawerOpen ? 'w-80 translate-x-0' : 'w-80 translate-x-full absolute right-0'
        )}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)]">
          <h3 className="text-sm font-heading font-semibold text-[var(--color-text-primary)]">
            Session
          </h3>
          <button
            onClick={() => setDrawerOpen(false)}
            className="text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors"
          >
            <X size={16} strokeWidth={1.5} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {drawerLoading ? (
            <div className="flex items-center justify-center h-20">
              <Loader2 size={20} className="animate-spin text-[var(--color-text-secondary)]" />
            </div>
          ) : drawerData ? (
            <div className="flex flex-col gap-4 animate-slide-in">
              {/* Session key */}
              <div>
                <div className="text-[10px] uppercase tracking-wider text-[var(--color-text-secondary)] mb-1 font-heading">
                  Session Key
                </div>
                <div className="mono-log text-[var(--color-accent)] break-all">
                  {drawerData.sessionKey}
                </div>
              </div>

              {/* Active run */}
              <div>
                <div className="text-[10px] uppercase tracking-wider text-[var(--color-text-secondary)] mb-1 font-heading">
                  Active Run
                </div>
                {drawerData.activeRun ? (
                  <div className="panel rounded px-3 py-2 text-xs">
                    <pre className="mono-log whitespace-pre-wrap break-words text-[var(--color-text-primary)]">
                      {JSON.stringify(drawerData.activeRun, null, 2)}
                    </pre>
                  </div>
                ) : (
                  <span className="text-[11px] text-[var(--color-text-secondary)]">None</span>
                )}
              </div>

              {/* Runs list */}
              <div>
                <div className="text-[10px] uppercase tracking-wider text-[var(--color-text-secondary)] mb-1 font-heading">
                  Runs ({Array.isArray(drawerData.runs) ? drawerData.runs.length : 0})
                </div>
                {Array.isArray(drawerData.runs) && drawerData.runs.length > 0 ? (
                  <div className="flex flex-col gap-1.5">
                    {drawerData.runs.map((run: unknown, i: number) => {
                      const r = run as Record<string, unknown>;
                      return (
                        <div key={i} className="panel rounded px-3 py-2 text-[11px] flex items-center gap-2">
                          <span className={statusDotClass((r.status as TaskStatus) || 'queued')} />
                          <span className="font-mono text-[var(--color-accent)] truncate">
                            {String(r.runId || r.id || i).slice(0, 16)}
                          </span>
                          <span className="text-[var(--color-text-secondary)] ml-auto">
                            {String(r.controlState || r.status || '—')}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <span className="text-[11px] text-[var(--color-text-secondary)]">
                    No runs in session
                  </span>
                )}
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-center h-20 text-[var(--color-text-secondary)] text-sm">
              No session data
            </div>
          )}
        </div>
      </div>

      {/* ── Toast ── */}
      {toast && (
        <div
          className={cn(
            'absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-2 px-4 py-2 rounded-md text-xs font-medium shadow-lg animate-fade-in-up z-50',
            toast.type === 'success'
              ? 'bg-[var(--color-accent)] text-[var(--color-bg)]'
              : 'bg-[var(--color-danger)] text-white'
          )}
        >
          {toast.type === 'success' ? (
            <CheckCircle size={14} />
          ) : (
            <XCircle size={14} />
          )}
          {toast.message}
        </div>
      )}
    </div>
  );
}
