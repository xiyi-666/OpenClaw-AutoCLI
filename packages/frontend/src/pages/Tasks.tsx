import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  Plus,
  Send,
  Square,
  Filter,
  ChevronRight,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Loader2,
  Clock,
  Trash2,
} from 'lucide-react';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { taskApi } from '../api';
import { useWsMessages } from '../useWebSocket';
import type {
  Task,
  TaskStatus,
  Runtime,
  CreateTaskPayload,
} from '../types';

function cn(...inputs: (string | boolean | undefined | null)[]) {
  return twMerge(clsx(inputs));
}

/* ─── status helpers ─── */

const STATUS_ORDER: TaskStatus[] = [
  'queued',
  'submitted',
  'running',
  'completed',
];

function statusDotClass(status: TaskStatus): string {
  switch (status) {
    case 'running':
    case 'submitted':
      return 'status-dot active';
    case 'queued':
      return 'status-dot idle';
    case 'completed':
      return 'status-dot active';
    case 'failed':
    case 'terminated':
      return 'status-dot danger';
    case 'paused':
      return 'status-dot warning';
    default:
      return 'status-dot idle';
  }
}

function statusLabel(status: TaskStatus | undefined | null): string {
  if (!status) return 'Unknown';
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function statusBadgeColor(status: TaskStatus): string {
  switch (status) {
    case 'running':
    case 'submitted':
      return 'bg-[var(--color-accent-dim)] text-[var(--color-accent)]';
    case 'queued':
      return 'bg-[var(--color-bg)] text-[var(--color-text-secondary)]';
    case 'completed':
      return 'bg-[var(--color-accent-dim)] text-[var(--color-accent)]';
    case 'failed':
    case 'terminated':
      return 'bg-[rgba(255,69,69,0.12)] text-[var(--color-danger)]';
    case 'paused':
      return 'bg-[rgba(245,166,35,0.12)] text-[var(--color-warning)]';
    default:
      return 'bg-[var(--color-bg)] text-[var(--color-text-secondary)]';
  }
}

function timelineStepIndex(status: TaskStatus): number {
  if (STATUS_ORDER.includes(status)) return STATUS_ORDER.indexOf(status);
  if (status === 'failed') return 3;
  if (status === 'terminated') return 2;
  if (status === 'paused') return 2;
  return 0;
}

function canSendInput(status: TaskStatus): boolean {
  return status === 'running' || status === 'submitted';
}

function canTerminate(status: TaskStatus): boolean {
  return status === 'running' || status === 'submitted' || status === 'queued' || status === 'paused';
}

function formatTime(ts?: string | number | null): string {
  if (!ts) return '—';
  const d = new Date(typeof ts === 'number' ? ts : ts);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function truncate(s: string | undefined | null, max: number): string {
  if (!s) return '';
  if (s.length <= max) return s;
  return s.slice(0, max) + '…';
}

function dedupeTasksById(list: Task[]): Task[] {
  const map = new Map<string, Task>();
  for (const item of list) {
    if (!item?.id) continue;
    map.set(item.id, item);
  }
  return Array.from(map.values()).sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
}

/* ─── Status Timeline ─── */

function StatusTimeline({ status }: { status: TaskStatus }) {
  const currentIndex = timelineStepIndex(status);
  const isFailed = status === 'failed';
  const isTerminated = status === 'terminated';
  const isPaused = status === 'paused';

  const stepLabels = ['Queued', 'Submitted', 'Running', isFailed ? 'Failed' : 'Completed'];

  return (
    <div className="flex items-center gap-0 py-4 px-2 overflow-x-auto">
      {stepLabels.map((label, i) => {
        const isReached = i <= currentIndex;
        const isCurrent = i === currentIndex;
        const isLast = i === stepLabels.length - 1;

        let circleColor = 'bg-[var(--color-border)]';
        if (isReached) {
          if (isLast && isFailed) {
            circleColor = 'bg-[var(--color-danger)]';
          } else {
            circleColor = 'bg-[var(--color-accent)]';
          }
        }

        let lineColor = 'bg-[var(--color-border)]';
        if (i < currentIndex) {
          if (isTerminated && i >= 2) {
            lineColor = 'bg-[var(--color-danger)]';
          } else {
            lineColor = 'bg-[var(--color-accent)]';
          }
        }

        return (
          <div key={label} className="flex items-center">
            {/* Circle */}
            <div className="flex flex-col items-center">
              <div
                className={cn(
                  'w-3 h-3 rounded-full shrink-0',
                  circleColor,
                  isCurrent && isReached && 'ring-2 ring-[var(--color-accent-dim)] ring-offset-1 ring-offset-[var(--color-bg-panel)]'
                )}
              />
              <span
                className={cn(
                  'text-[10px] mt-1.5 whitespace-nowrap',
                  isReached
                    ? 'text-[var(--color-text-primary)]'
                    : 'text-[var(--color-text-secondary)]'
                )}
              >
                {label}
              </span>
            </div>
            {/* Connector line */}
            {!isLast && (
              <div
                className={cn(
                  'h-0.5 w-10 mx-1 mt-[-14px]',
                  lineColor
                )}
              />
            )}
          </div>
        );
      })}
      {/* Extra labels for terminated / paused */}
      {(isTerminated || isPaused) && (
        <div className="flex flex-col items-center ml-3">
          <div
            className={cn(
              'w-3 h-3 rounded-full shrink-0',
              isTerminated ? 'bg-[var(--color-danger)]' : 'bg-[var(--color-warning)]'
            )}
          />
          <span className="text-[10px] mt-1.5 text-[var(--color-danger)] whitespace-nowrap">
            {isTerminated ? 'Terminated' : 'Paused'}
          </span>
        </div>
      )}
    </div>
  );
}

/* ─── Create Task Modal ─── */

function CreateTaskModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (task: Task) => void;
}) {
  const [prompt, setPrompt] = useState('');
  const [runtime, setRuntime] = useState<Runtime>('codex');
  const [sessionKey, setSessionKey] = useState('');
  const [agentId, setAgentId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = useCallback(async () => {
    if (!prompt.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const payload: CreateTaskPayload = {
        prompt: prompt.trim(),
        runtime,
      };
      if (sessionKey.trim()) payload.sessionKey = sessionKey.trim();
      if (agentId.trim()) payload.agentId = agentId.trim();

      const res = await taskApi.create(payload);
      if (res.ok && res.task) {
        onCreated(res.task);
        setPrompt('');
        setSessionKey('');
        setAgentId('');
        onClose();
      } else {
        setError(res.error || 'Failed to create task');
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setSubmitting(false);
    }
  }, [prompt, runtime, sessionKey, agentId, onCreated, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 animate-fade-in-up">
      <div className="panel rounded-lg w-full max-w-lg mx-4 p-6 space-y-4 animate-fade-in-up">
        <h2 className="text-sm font-heading font-semibold text-[var(--color-text-primary)] tracking-wide">
          NEW TASK
        </h2>

        <div>
          <label className="block text-xs text-[var(--color-text-secondary)] mb-1">
            Prompt <span className="text-[var(--color-danger)]">*</span>
          </label>
          <textarea
            className="w-full h-28 rounded px-3 py-2 text-sm resize-none"
            placeholder="Describe the task..."
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-[var(--color-text-secondary)] mb-1">
              Runtime
            </label>
            <select
              className="w-full rounded px-3 py-2 text-sm"
              value={runtime}
              onChange={(e) => setRuntime(e.target.value as Runtime)}
            >
              <option value="codex">codex</option>
              <option value="claude">claude</option>
              <option value="gemini">gemini</option>
              <option value="opencode">opencode</option>
              <option value="openclaw">openclaw</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-[var(--color-text-secondary)] mb-1">
              Session Key
            </label>
            <input
              className="w-full rounded px-3 py-2 text-sm"
              placeholder="optional"
              value={sessionKey}
              onChange={(e) => setSessionKey(e.target.value)}
            />
          </div>
        </div>

        <div>
          <label className="block text-xs text-[var(--color-text-secondary)] mb-1">
            Agent ID
          </label>
          <input
            className="w-full rounded px-3 py-2 text-sm"
            placeholder="optional"
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
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
              (!prompt.trim() || submitting) && 'opacity-50 cursor-not-allowed'
            )}
            disabled={!prompt.trim() || submitting}
            onClick={handleSubmit}
          >
            {submitting ? <Loader2 size={14} className="animate-spin inline" /> : <Plus size={14} className="inline" />}
            {' '}Create
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─── Main Component ─── */

export default function Tasks() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [filter, setFilter] = useState<TaskStatus | 'all'>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [inputMsg, setInputMsg] = useState('');
  const [sending, setSending] = useState(false);
  const [terminating, setTerminating] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLDivElement>(null);
  const lastHandledWsRef = useRef<string>('');
  const wsEventTypes = useMemo(
    () => ['task_updated', 'task_added', 'task_submitted', 'task_terminated'],
    [],
  );

  /* ── WebSocket ── */
  const { messages: wsMessages } = useWsMessages(wsEventTypes);

  /* ── Scroll to bottom on detail updates ── */
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [selectedTask?.answerText, selectedTask?.error]);

  /* ── Close filter dropdown on outside click ── */
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (filterRef.current && !filterRef.current.contains(e.target as Node)) {
        setFilterOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  /* ── Fetch task list ── */
  const fetchTasks = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await taskApi.list();
      if (res.ok) {
        setTasks(dedupeTasksById(res.tasks ?? []));
      } else {
        setError(res.error || 'Failed to load tasks');
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTasks();
  }, [fetchTasks]);

  /* ── Select task → fetch detail ── */
  const selectTask = useCallback(async (id: string) => {
    setSelectedId(id);
    try {
      const res = await taskApi.getById(id);
      if (res.ok && res.task) {
        setSelectedTask(res.task);
      }
    } catch {
      // silently ignore — list data still available
    }
  }, []);

  /* ── WS: patch tasks list & detail ── */
  useEffect(() => {
    if (wsMessages.length === 0) return;
    const latest = wsMessages[wsMessages.length - 1];
    if (!latest.task) return;
    const wsKey = `${wsMessages.length}:${latest.type}:${latest.task.id}:${latest.task.updatedAt ?? ''}:${latest.task.status ?? ''}`;
    if (lastHandledWsRef.current === wsKey) return;
    lastHandledWsRef.current = wsKey;

    const updated = latest.task;
    setTasks((prev) => {
      let changed = false;
      const next = prev.map((t) => {
        if (t.id !== updated.id) return t;
        changed = true;
        return { ...t, ...updated };
      });
      return changed ? next : prev;
    });

    // Also prepend if it's a new task (task_added)
    if (latest.type === 'task_added') {
      setTasks((prev) => {
        if (prev.some((t) => t.id === updated.id)) return prev;
        return dedupeTasksById([updated, ...prev]);
      });
    }

    if (selectedId === updated.id) {
      setSelectedTask((prev) => {
        if (!prev) return updated;
        const next = { ...prev, ...updated };
        if (
          prev.status === next.status &&
          prev.updatedAt === next.updatedAt &&
          prev.answerText === next.answerText &&
          prev.error === next.error
        ) {
          return prev;
        }
        return next;
      });
    }
  }, [wsMessages.length, selectedId]);

  /* ── Send input ── */
  const handleSendInput = useCallback(async () => {
    if (!selectedId || !inputMsg.trim() || sending) return;
    setSending(true);
    try {
      await taskApi.sendInput(selectedId, { message: inputMsg.trim() });
      setInputMsg('');
      // Refresh detail
      const res = await taskApi.getById(selectedId);
      if (res.ok && res.task) setSelectedTask(res.task);
    } catch {
      // ignore
    } finally {
      setSending(false);
    }
  }, [selectedId, inputMsg, sending]);

  /* ── Terminate ── */
  const handleTerminate = useCallback(async () => {
    if (!selectedId || terminating) return;
    setTerminating(true);
    try {
      await taskApi.terminate(selectedId);
      const res = await taskApi.getById(selectedId);
      if (res.ok && res.task) setSelectedTask(res.task);
    } catch {
      // ignore
    } finally {
      setTerminating(false);
    }
  }, [selectedId, terminating]);

  /* ── Dismiss (remove from memory) ── */
  const handleDismiss = useCallback(async () => {
    if (!selectedId || dismissing) return;
    setDismissing(true);
    try {
      await taskApi.dismiss(selectedId);
      setTasks((prev) => prev.filter((t) => t.id !== selectedId));
      setSelectedId(null);
      setSelectedTask(null);
    } catch {
      // ignore
    } finally {
      setDismissing(false);
    }
  }, [selectedId, dismissing]);

  /* ── Derived ── */
  const filteredTasks =
    filter === 'all' ? tasks : tasks.filter((t) => t.status === filter);

  const FILTER_OPTIONS: (TaskStatus | 'all')[] = [
    'all',
    'queued',
    'submitted',
    'running',
    'completed',
    'failed',
    'terminated',
    'paused',
  ];

  /* ─── RENDER ─── */

  return (
    <div className="flex h-full min-h-0">
      {/* ── Left panel ── */}
      <div className="w-80 shrink-0 border-r border-[var(--color-border)] flex flex-col bg-[var(--color-bg-panel)]">
        {/* Toolbar */}
        <div className="flex items-center gap-2 px-3 py-3 border-b border-[var(--color-border)]">
          {/* Filter dropdown */}
          <div ref={filterRef} className="relative flex-1">
            <button
              className="flex items-center gap-1.5 w-full px-3 py-1.5 rounded text-xs border border-[var(--color-border)] bg-[var(--color-bg)] hover:border-[var(--color-accent)] transition-colors"
              onClick={() => setFilterOpen((v) => !v)}
            >
              <Filter size={12} strokeWidth={1.5} />
              <span className="flex-1 text-left text-[var(--color-text-primary)]">
                {filter === 'all' ? 'All' : statusLabel(filter)}
              </span>
              <ChevronRight
                size={12}
                strokeWidth={1.5}
                className={cn(
                  'transition-transform',
                  filterOpen && 'rotate-90'
                )}
              />
            </button>
            {filterOpen && (
              <div className="absolute top-full left-0 mt-1 w-full z-20 panel rounded py-1 animate-fade-in-up">
                {FILTER_OPTIONS.map((opt) => (
                  <button
                    key={opt}
                    className={cn(
                      'w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--color-accent-dim)] transition-colors',
                      filter === opt
                        ? 'text-[var(--color-accent)]'
                        : 'text-[var(--color-text-primary)]'
                    )}
                    onClick={() => {
                      setFilter(opt);
                      setFilterOpen(false);
                    }}
                  >
                    {opt === 'all' ? 'All' : statusLabel(opt)}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* New task */}
          <button
            className="flex items-center gap-1 px-3 py-1.5 rounded text-xs bg-[var(--color-accent)] text-[var(--color-bg)] font-semibold hover:opacity-90 transition-opacity shrink-0"
            onClick={() => setShowCreate(true)}
          >
            <Plus size={14} strokeWidth={1.5} />
            NEW
          </button>
        </div>

        {/* Task list */}
        <div className="flex-1 overflow-y-auto">
          {loading && tasks.length === 0 ? (
            <div className="flex items-center justify-center h-32 text-[var(--color-text-secondary)] text-xs animate-pulse">
              Loading tasks...
            </div>
          ) : error && tasks.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-32 text-[var(--color-danger)] text-xs gap-1">
              <AlertTriangle size={16} />
              {error}
            </div>
          ) : filteredTasks.length === 0 ? (
            <div className="flex items-center justify-center h-32 text-[var(--color-text-secondary)] text-xs">
              No tasks found
            </div>
          ) : (
            <div className="divide-y divide-[var(--color-border)]">
              {filteredTasks.map((task) => (
                <button
                  key={task.id}
                  className={cn(
                    'w-full text-left px-3 py-2.5 flex items-start gap-2.5 transition-colors',
                    'hover:bg-[var(--color-accent-dim)]',
                    selectedId === task.id && 'bg-[var(--color-accent-dim)]'
                  )}
                  onClick={() => selectTask(task.id)}
                >
                  <span className={statusDotClass(task.status)} style={{ marginTop: 6 }} />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-semibold text-[var(--color-text-primary)] truncate font-heading">
                      {task.id}
                    </div>
                    <div className="text-[11px] text-[var(--color-text-secondary)] truncate mt-0.5">
                      {truncate(task.prompt, 60)}
                    </div>
                    <div className="text-[10px] text-[var(--color-text-secondary)] mt-0.5">
                      {statusLabel(task.status)}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── Right panel ── */}
      <div className="flex-1 flex flex-col min-w-0 bg-[var(--color-bg)]">
        {!selectedTask ? (
          /* Empty state */
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center space-y-2">
              <div className="text-[var(--color-text-secondary)] text-sm">
                Select a task to view details
              </div>
            </div>
          </div>
        ) : (
          <>
            {/* Header */}
            <div className="px-5 py-3 border-b border-[var(--color-border)] bg-[var(--color-bg-panel)] shrink-0">
              <div className="flex items-center gap-3">
                <h2 className="text-sm font-heading font-semibold text-[var(--color-text-primary)] tracking-wide truncate">
                  {selectedTask.id}
                </h2>
                <span
                  className={cn(
                    'text-[10px] font-semibold px-2 py-0.5 rounded-full',
                    statusBadgeColor(selectedTask.status)
                  )}
                >
                  {statusLabel(selectedTask.status)}
                </span>
              </div>
              {/* Status timeline */}
              <StatusTimeline status={selectedTask.status} />
            </div>

            {/* Messages / Output */}
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
              {/* Initial prompt */}
              <div className="animate-fade-in-up">
                <div className="text-[10px] text-[var(--color-text-secondary)] mb-1 font-heading uppercase tracking-wider">
                  Prompt
                </div>
                <div className="panel rounded p-3 text-sm text-[var(--color-text-primary)] whitespace-pre-wrap mono-log">
                  {selectedTask.prompt}
                </div>
              </div>

              {/* Answer */}
              {selectedTask.answerText && (
                <div className="animate-fade-in-up">
                  <div className="text-[10px] text-[var(--color-accent)] mb-1 font-heading uppercase tracking-wider">
                    Output
                  </div>
                  <div className="panel rounded p-3 text-sm text-[var(--color-accent)] whitespace-pre-wrap mono-log">
                    {selectedTask.answerText}
                  </div>
                </div>
              )}

              {/* Error */}
              {selectedTask.error && (
                <div className="animate-fade-in-up">
                  <div className="text-[10px] text-[var(--color-danger)] mb-1 font-heading uppercase tracking-wider flex items-center gap-1">
                    <XCircle size={10} />
                    Error
                  </div>
                  <div className="panel rounded p-3 text-sm text-[var(--color-danger)] whitespace-pre-wrap mono-log border-[var(--color-danger)]">
                    {selectedTask.error}
                  </div>
                </div>
              )}

              {/* Timestamps */}
              <div className="flex gap-4 text-[10px] text-[var(--color-text-secondary)] pt-2">
                {selectedTask.submittedAt && (
                  <span className="flex items-center gap-1">
                    <Clock size={10} />
                    Submitted: {formatTime(selectedTask.submittedAt)}
                  </span>
                )}
                {selectedTask.updatedAt && (
                  <span>Updated: {formatTime(selectedTask.updatedAt)}</span>
                )}
                {selectedTask.completedAt && (
                  <span className="flex items-center gap-1">
                    <CheckCircle size={10} />
                    Completed: {formatTime(selectedTask.completedAt)}
                  </span>
                )}
              </div>

              <div ref={messagesEndRef} />
            </div>

            {/* Input bar */}
            {canSendInput(selectedTask.status) && (
              <div className="px-5 py-3 border-t border-[var(--color-border)] bg-[var(--color-bg-panel)] shrink-0">
                <div className="flex items-center gap-2">
                  <input
                    className="flex-1 rounded px-3 py-2 text-sm"
                    placeholder="Send input to task..."
                    value={inputMsg}
                    onChange={(e) => setInputMsg(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        handleSendInput();
                      }
                    }}
                  />
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
            )}

            {/* Terminate button */}
            {canTerminate(selectedTask.status) && (
              <div className="px-5 py-3 border-t border-[var(--color-border)] bg-[var(--color-bg-panel)] shrink-0">
                <button
                  className={cn(
                    'flex items-center gap-1.5 px-4 py-2 rounded text-xs font-semibold',
                    'bg-[rgba(255,69,69,0.15)] text-[var(--color-danger)] border border-[var(--color-danger)]',
                    'hover:bg-[rgba(255,69,69,0.25)] transition-colors',
                    terminating && 'opacity-50 cursor-not-allowed'
                  )}
                  disabled={terminating}
                  onClick={handleTerminate}
                >
                  {terminating ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <Square size={14} strokeWidth={1.5} />
                  )}
                  TERMINATE
                </button>
              </div>
            )}

            {/* Dismiss button — remove completed/failed/terminated task from memory */}
            {['completed', 'failed', 'terminated'].includes(selectedTask.status) && (
              <div className="px-5 py-3 border-t border-[var(--color-border)] bg-[var(--color-bg-panel)] shrink-0">
                <button
                  className={cn(
                    'flex items-center gap-1.5 px-4 py-2 rounded text-xs font-semibold',
                    'bg-[var(--color-bg-input)] text-[var(--color-text-muted)] border border-[var(--color-border)]',
                    'hover:text-[var(--color-text)] hover:border-[var(--color-text-muted)] transition-colors',
                    dismissing && 'opacity-50 cursor-not-allowed'
                  )}
                  disabled={dismissing}
                  onClick={handleDismiss}
                >
                  {dismissing ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} strokeWidth={1.5} />}
                  DISMISS
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {/* Create task modal */}
      <CreateTaskModal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        onCreated={(task) => {
          setTasks((prev) => dedupeTasksById([task, ...prev]));
          selectTask(task.id);
        }}
      />
    </div>
  );
}
