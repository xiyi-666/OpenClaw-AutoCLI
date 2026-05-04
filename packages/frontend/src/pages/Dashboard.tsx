import { useEffect, useState, useRef, useCallback } from 'react';
import {
  Clock,
  Send,
  CheckCircle,
  XCircle,
  Activity,
  Terminal,
} from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { taskApi, sessionApi } from '../api';
import { useWsMessages } from '../useWebSocket';
import type { Task, TaskStats, Session, WsMessage } from '../types';
import { wsMessageText } from '../types';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/* ──────────── helpers ──────────── */

function statusToDotClass(status: string): string {
  switch (status) {
    case 'running':
      return 'status-dot active';
    case 'completed':
      return 'status-dot active';
    case 'failed':
      return 'status-dot danger';
    case 'paused':
      return 'status-dot warning';
    case 'terminated':
      return 'status-dot danger';
    case 'queued':
    case 'submitted':
      return 'status-dot warning';
    default:
      return 'status-dot idle';
  }
}

function formatTime(ts: string | number | undefined): string {
  if (!ts) return '--:--:--';
  const d = typeof ts === 'number' && ts < 1e12 ? new Date(ts * 1000) : new Date(ts);
  return d.toLocaleTimeString('zh-CN', { hour12: false });
}

function truncate(str: string | undefined | null, max: number): string {
  if (!str) return '';
  return str.length > max ? str.slice(0, max) + '…' : str;
}

function describeMessage(msg: WsMessage): string {
  if (msg.task) {
    const t = msg.task;
    return `${t.id || '?'} → ${t.status || '?'}${t.error ? ` (${t.error})` : ''}`;
  }
  if (msg.session) {
    return `${msg.session.id || '?'} [${msg.session.cliType ?? 'unknown'}]`;
  }
  if (msg.data) {
    return truncate(String(msg.data), 80);
  }
  if (msg.message) {
    return truncate(wsMessageText(msg.message), 80);
  }
  return '';
}

/* ──────────── stat card config ──────────── */

interface StatCardDef {
  key: string;
  label: string;
  icon: typeof Clock;
  accentBorder: string;
  getValue: (stats: TaskStats) => number;
}

const STAT_CARDS: StatCardDef[] = [
  {
    key: 'active',
    label: 'Active',
    icon: Clock,
    accentBorder: 'border-l-[var(--color-accent)]',
    getValue: (s) => s.active ?? 0,
  },
  {
    key: 'completed',
    label: 'Completed',
    icon: CheckCircle,
    accentBorder: 'border-l-[#22c55e]',
    getValue: (s) => s.completed ?? 0,
  },
  {
    key: 'failed',
    label: 'Failed',
    icon: XCircle,
    accentBorder: 'border-l-[var(--color-danger)]',
    getValue: (s) => s.failed ?? 0,
  },
  {
    key: 'terminated',
    label: 'Terminated',
    icon: Send,
    accentBorder: 'border-l-[var(--color-warning)]',
    getValue: (s) => s.terminated ?? 0,
  },
];

/* ──────────── Dashboard page ──────────── */

export default function Dashboard() {
  const [stats, setStats] = useState<TaskStats | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);

  const { messages: filteredMessages } = useWsMessages(['task_updated', 'task_added', 'task_submitted', 'run_event']);
  const { messages: allMessages } = useWsMessages();
  const logEndRef = useRef<HTMLDivElement>(null);

  /* ── fetch data ── */
  const fetchAll = useCallback(async () => {
    try {
      const [statsRes, tasksRes, sessionsRes] = await Promise.all([
        taskApi.getStats(),
        taskApi.list(),
        sessionApi.list(),
      ]);
      if (statsRes.ok && statsRes.stats) setStats(statsRes.stats);
      if (tasksRes.ok && tasksRes.tasks) setTasks(tasksRes.tasks.slice(0, 5));
      if (sessionsRes.ok && sessionsRes.sessions) setSessions(sessionsRes.sessions.slice(0, 5));
    } catch (err) {
      console.error('[Dashboard] fetch error', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  /* ── refresh stats on relevant WS events ── */
  useEffect(() => {
    if (filteredMessages.length === 0) return;
    taskApi
      .getStats()
      .then((res) => {
        if (res.ok && res.stats) setStats(res.stats);
      })
      .catch(() => {});

    // Also refresh task list
    taskApi
      .list()
      .then((res) => {
        if (res.ok && res.tasks) setTasks(res.tasks.slice(0, 5));
      })
      .catch(() => {});
  }, [filteredMessages]);

  /* ── auto-scroll events log ── */
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [allMessages]);

  return (
    <div className="p-5 flex flex-col gap-5 h-full overflow-auto">
      {/* ── Stats Row ── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {STAT_CARDS.map((card) => {
          const Icon = card.icon;
          const value = stats ? card.getValue(stats) : 0;
          return (
            <div
              key={card.key}
              className={cn(
                'panel rounded-lg px-4 py-3 border-l-4 flex items-center gap-3 animate-fade-in-up',
                card.accentBorder,
                loading && 'animate-pulse'
              )}
            >
              <Icon
                size={18}
                strokeWidth={1.5}
                className="text-[var(--color-text-secondary)] shrink-0"
              />
              <div className="min-w-0">
                <div className="text-xs text-[var(--color-text-secondary)] font-body uppercase tracking-wider">
                  {card.label}
                </div>
                <div className="text-2xl font-number text-[var(--color-text-primary)] leading-tight">
                  {loading ? '-' : value}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* ── Middle: Recent Tasks + Real-time Events ── */}
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-5 gap-4 min-h-0">
        {/* Recent Tasks (3 cols) */}
        <div className="lg:col-span-3 panel rounded-lg flex flex-col min-h-0 overflow-hidden">
          <div className="px-4 py-3 border-b border-[var(--color-border)] shrink-0 flex items-center gap-2">
            <Activity size={16} strokeWidth={1.5} className="text-[var(--color-accent)]" />
            <h2 className="text-sm font-heading tracking-wide text-[var(--color-text-primary)]">
              Recent Tasks
            </h2>
            <span className="ml-auto text-xs text-[var(--color-text-secondary)]">
              {tasks.length} / 5
            </span>
          </div>
          <div className="flex-1 overflow-y-auto">
            {tasks.length === 0 ? (
              <div className="flex items-center justify-center h-full text-[var(--color-text-secondary)] text-sm">
                {loading ? 'Loading…' : 'No tasks yet'}
              </div>
            ) : (
              <ul>
                {tasks.map((task, i) => (
                  <li
                    key={task.id}
                    className={cn(
                      'flex items-center gap-3 px-4 py-2.5 border-b border-[var(--color-border)] last:border-b-0 hover:bg-[var(--color-accent-dim)] transition-colors cursor-default animate-slide-in',
                    )}
                    style={{ animationDelay: `${i * 40}ms` }}
                  >
                    <span className={statusToDotClass(task.status || 'idle')} />
                    <span className="text-xs font-mono text-[var(--color-text-secondary)] shrink-0 w-20 truncate">
                      {truncate(task.id, 10)}
                    </span>
                    <span className="text-sm text-[var(--color-text-primary)] truncate flex-1 min-w-0">
                      {truncate(task.prompt, 60)}
                    </span>
                    <span className="text-xs text-[var(--color-text-secondary)] shrink-0">
                      {formatTime(task.updatedAt || task.submittedAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* Real-time Events (2 cols) */}
        <div className="lg:col-span-2 panel rounded-lg flex flex-col min-h-0 overflow-hidden">
          <div className="px-4 py-3 border-b border-[var(--color-border)] shrink-0 flex items-center gap-2">
            <Terminal size={16} strokeWidth={1.5} className="text-[var(--color-accent)]" />
            <h2 className="text-sm font-heading tracking-wide text-[var(--color-text-primary)]">
              Real-time Events
            </h2>
            <span className="ml-auto text-xs text-[var(--color-text-secondary)]">
              {allMessages.length}
            </span>
          </div>
          <div className="flex-1 overflow-y-auto mono-log px-3 py-2">
            {allMessages.length === 0 ? (
              <div className="flex items-center h-full text-[var(--color-text-secondary)] text-xs">
                <span>Waiting for events…</span>
                <span className="cursor-blink ml-1 text-[var(--color-accent)]">█</span>
              </div>
            ) : (
              <>
                {allMessages.map((msg, i) => (
                  <div
                    key={i}
                    className="text-[var(--color-accent)] hover:bg-[var(--color-accent-dim)] transition-colors leading-6 animate-fade-in-up"
                  >
                    <span className="text-[var(--color-text-secondary)] mr-2">
                      {formatTime(msg.timestamp ?? Date.now())}
                    </span>
                    <span className="text-[var(--color-warning)] mr-2">{msg.type}</span>
                    <span>{describeMessage(msg)}</span>
                  </div>
                ))}
                <div ref={logEndRef} />
                <span className="cursor-blink text-[var(--color-accent)]">█</span>
              </>
            )}
          </div>
        </div>
      </div>

      {/* ── Bottom: Recent Sessions ── */}
      <div className="shrink-0">
        <div className="flex items-center gap-2 mb-2">
          <h2 className="text-sm font-heading tracking-wide text-[var(--color-text-primary)]">
            Recent Sessions
          </h2>
          <span className="text-xs text-[var(--color-text-secondary)]">
            {sessions.length} / 5
          </span>
        </div>
        <div className="flex gap-3 overflow-x-auto pb-2">
          {sessions.length === 0 ? (
            <div className="text-sm text-[var(--color-text-secondary)] pl-1">
              {loading ? 'Loading…' : 'No sessions yet'}
            </div>
          ) : (
            sessions.map((session, i) => (
              <div
                key={session.id}
                className="panel rounded-lg px-4 py-2.5 shrink-0 w-56 flex items-center gap-3 animate-fade-in-up hover:border-[var(--color-accent)] transition-colors"
                style={{ animationDelay: `${i * 60}ms` }}
              >
                <span className={statusToDotClass(session.status || 'idle')} />
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-mono text-[var(--color-text-primary)] truncate">
                    {truncate(session.id, 14)}
                  </div>
                  <div className="text-xs text-[var(--color-text-secondary)] truncate">
                    {session.cliType ?? 'unknown'}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
