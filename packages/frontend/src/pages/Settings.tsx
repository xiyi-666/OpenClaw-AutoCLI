import { useState, useEffect, useCallback } from 'react';
import {
  Pause,
  Play,
  Square,
  Loader2,
  CheckCircle,
  XCircle,
  Cpu,
  Database,
  FileText,
} from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { bridgeApi, callbackApi } from '../api';
import type { Runtime, ThreadControlPayload, CallbackLogItem } from '../types';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/* ── Runtime placeholder data ── */

interface RuntimeInfo {
  name: Runtime;
  label: string;
  status: 'active' | 'idle';
  config: Record<string, string>;
}

const RUNTIMES: RuntimeInfo[] = [
  {
    name: 'codex',
    label: 'Codex',
    status: 'active',
    config: { model: 'codex-1', timeout: '30s', maxRetries: '3' },
  },
  {
    name: 'claude',
    label: 'Claude',
    status: 'active',
    config: { model: 'claude-sonnet-4-20250514', timeout: '60s', maxRetries: '2' },
  },
  {
    name: 'gemini',
    label: 'Gemini',
    status: 'idle',
    config: { model: 'gemini-2.5-pro', timeout: '45s', maxRetries: '2' },
  },
  {
    name: 'openclaw',
    label: 'OpenClaw',
    status: 'active',
    config: { channel: 'default', callbackUrl: '/callbacks/openclaw' },
  },
];

/* ── Component ──────────────────────────────────────── */

export default function Settings() {
  /* ── Thread control state ── */
  const [threadId, setThreadId] = useState('');
  const [threadLoading, setThreadLoading] = useState(false);
  const [threadResult, setThreadResult] = useState<{
    action: string;
    ok: boolean;
  } | null>(null);

  /* ── Callback log state ── */
  const [callbacks, setCallbacks] = useState<CallbackLogItem[]>([]);
  const [callbacksLoading, setCallbacksLoading] = useState(true);
  const [callbacksError, setCallbacksError] = useState<string | null>(null);

  /* ── Toast ── */
  const [toast, setToast] = useState<{
    message: string;
    type: 'success' | 'error';
  } | null>(null);

  const showToast = useCallback(
    (message: string, type: 'success' | 'error' = 'success') => {
      setToast({ message, type });
      setTimeout(() => setToast(null), 3000);
    },
    []
  );

  /* ── Fetch callbacks on mount ── */
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        setCallbacksLoading(true);
        setCallbacksError(null);
        const res = await callbackApi.list();
        if (cancelled) return;
        if (res.ok && res.callbacks) {
          setCallbacks(res.callbacks as CallbackLogItem[]);
        } else {
          setCallbacksError(res.error || 'Failed to load callbacks');
        }
      } catch (err) {
        if (cancelled) return;
        setCallbacksError(
          err instanceof Error ? err.message : 'Unknown error'
        );
      } finally {
        if (!cancelled) setCallbacksLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  /* ── Thread control ── */
  const handleThreadControl = useCallback(
    async (action: ThreadControlPayload['action']) => {
      if (!threadId.trim()) return;
      setThreadLoading(true);
      setThreadResult(null);
      try {
        const res = await bridgeApi.controlThread(threadId.trim(), { action });
        if (res.ok) {
          setThreadResult({ action, ok: true });
          showToast(`Thread ${action}d`);
        } else {
          setThreadResult({ action, ok: false });
          showToast(res.error || `Thread ${action} failed`, 'error');
        }
      } catch (err) {
        setThreadResult({ action, ok: false });
        showToast(
          err instanceof Error ? err.message : `Thread ${action} failed`,
          'error'
        );
      } finally {
        setThreadLoading(false);
      }
    },
    [threadId, showToast]
  );

  /* ── Format timestamp for callbacks ── */
  function formatCbTimestamp(ts?: number | string | null): string {
    if (!ts) return '—';
    const d = new Date(ts);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleString([], {
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  /* ── Truncate JSON ── */
  function truncateJson(obj: unknown, maxLen = 80): string {
    const str = JSON.stringify(obj, null, 0);
    if (str.length <= maxLen) return str;
    return str.slice(0, maxLen) + '…';
  }

  /* ── Render ── */
  return (
    <div className="h-full overflow-y-auto p-5 flex flex-col gap-8 relative">
      {/* ── Section: RUNTIMES ── */}
      <section>
        <h2 className="text-sm font-heading font-semibold text-[var(--color-text-primary)] uppercase tracking-wider mb-4 flex items-center gap-2">
          <Cpu size={16} strokeWidth={1.5} className="text-[var(--color-accent)]" />
          Runtimes
        </h2>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {RUNTIMES.map((rt) => (
            <div
              key={rt.name}
              className="panel rounded-lg p-4 flex flex-col gap-3 animate-fade-in-up"
            >
              {/* Header */}
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-heading font-bold text-[var(--color-text-primary)] uppercase tracking-wider">
                  {rt.label}
                </h3>
                <span
                  className={cn(
                    'flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider',
                    rt.status === 'active'
                      ? 'text-[var(--color-accent)]'
                      : 'text-[var(--color-text-secondary)]'
                  )}
                >
                  <span
                    className={cn(
                      'status-dot',
                      rt.status === 'active' ? 'active' : 'idle'
                    )}
                  />
                  {rt.status}
                </span>
              </div>

              {/* Config key-value pairs */}
              <div className="flex flex-col gap-1">
                {Object.entries(rt.config).map(([key, value]) => (
                  <div
                    key={key}
                    className="flex items-center justify-between text-[11px] gap-2"
                  >
                    <span className="text-[var(--color-text-secondary)] shrink-0">
                      {key}
                    </span>
                    <span className="font-mono text-[var(--color-text-primary)] truncate text-right">
                      {value}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ── Section: THREAD CONTROL ── */}
      <section>
        <h2 className="text-sm font-heading font-semibold text-[var(--color-text-primary)] uppercase tracking-wider mb-4 flex items-center gap-2">
          <Database size={16} strokeWidth={1.5} className="text-[var(--color-accent)]" />
          Thread Control
        </h2>

        <div className="panel rounded-lg p-4">
          <div className="flex items-center gap-3 flex-wrap">
            <input
              value={threadId}
              onChange={(e) => setThreadId(e.target.value)}
              placeholder="Enter thread ID..."
              className="flex-1 min-w-[200px] rounded-md px-3 py-1.5 text-sm"
            />

            <button
              onClick={() => handleThreadControl('pause')}
              disabled={threadLoading || !threadId.trim()}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-opacity',
                threadId.trim()
                  ? 'text-[var(--color-warning)] border border-[var(--color-warning)] hover:bg-[var(--color-warning)] hover:bg-opacity-10'
                  : 'text-[var(--color-text-secondary)] border border-[var(--color-border)] cursor-not-allowed'
              )}
            >
              <Pause size={14} strokeWidth={1.5} />
              PAUSE
            </button>

            <button
              onClick={() => handleThreadControl('resume')}
              disabled={threadLoading || !threadId.trim()}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-opacity',
                threadId.trim()
                  ? 'text-[var(--color-accent)] border border-[var(--color-accent)] hover:bg-[var(--color-accent)] hover:bg-opacity-10'
                  : 'text-[var(--color-text-secondary)] border border-[var(--color-border)] cursor-not-allowed'
              )}
            >
              <Play size={14} strokeWidth={1.5} />
              RESUME
            </button>

            <button
              onClick={() => handleThreadControl('terminate')}
              disabled={threadLoading || !threadId.trim()}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-opacity',
                threadId.trim()
                  ? 'text-[var(--color-danger)] border border-[var(--color-danger)] hover:bg-[var(--color-danger)] hover:bg-opacity-10'
                  : 'text-[var(--color-text-secondary)] border border-[var(--color-border)] cursor-not-allowed'
              )}
            >
              <Square size={14} strokeWidth={1.5} />
              TERMINATE
            </button>

            {threadLoading && (
              <Loader2 size={16} className="animate-spin text-[var(--color-text-secondary)]" />
            )}
          </div>

          {/* Result feedback */}
          {threadResult && (
            <div
              className={cn(
                'mt-3 flex items-center gap-2 text-xs animate-fade-in-up',
                threadResult.ok
                  ? 'text-[var(--color-accent)]'
                  : 'text-[var(--color-danger)]'
              )}
            >
              {threadResult.ok ? (
                <CheckCircle size={14} />
              ) : (
                <XCircle size={14} />
              )}
              <span>
                {threadResult.ok
                  ? `Thread ${threadResult.action}d successfully`
                  : `Thread ${threadResult.action} failed`}
              </span>
            </div>
          )}
        </div>
      </section>

      {/* ── Section: CALLBACK LOG ── */}
      <section>
        <h2 className="text-sm font-heading font-semibold text-[var(--color-text-primary)] uppercase tracking-wider mb-4 flex items-center gap-2">
          <FileText size={16} strokeWidth={1.5} className="text-[var(--color-accent)]" />
          Callback Log
        </h2>

        <div className="panel rounded-lg overflow-hidden">
          {callbacksLoading ? (
            <div className="flex items-center justify-center h-24">
              <Loader2
                size={20}
                className="animate-spin text-[var(--color-text-secondary)]"
              />
            </div>
          ) : callbacksError ? (
            <div className="flex items-center justify-center h-24 gap-2 text-[var(--color-danger)] text-sm">
              <XCircle size={16} />
              {callbacksError}
            </div>
          ) : callbacks.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-24 text-[var(--color-text-secondary)] text-sm gap-2">
              <FileText size={24} strokeWidth={1.5} className="opacity-40" />
              <span>No callback records</span>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[11px]">
                <thead>
                  <tr className="border-b border-[var(--color-border)]">
                    <th className="px-4 py-2.5 font-heading font-medium text-[var(--color-text-secondary)] uppercase tracking-wider">
                      ID
                    </th>
                    <th className="px-4 py-2.5 font-heading font-medium text-[var(--color-text-secondary)] uppercase tracking-wider">
                      Timestamp
                    </th>
                    <th className="px-4 py-2.5 font-heading font-medium text-[var(--color-text-secondary)] uppercase tracking-wider">
                      Payload
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {callbacks.map((cb, i) => (
                    <tr
                      key={cb.id || i}
                      className="border-b border-[var(--color-border)] last:border-b-0 hover:bg-[var(--color-bg)] transition-colors"
                    >
                      <td className="px-4 py-2 font-mono text-[var(--color-accent)] whitespace-nowrap">
                        {(cb.id || i).toString().slice(0, 12)}
                      </td>
                      <td className="px-4 py-2 text-[var(--color-text-secondary)] whitespace-nowrap">
                        {formatCbTimestamp(cb.timestamp)}
                      </td>
                      <td className="px-4 py-2 font-mono text-[var(--color-text-primary)] max-w-xs truncate">
                        {truncateJson(cb.payload)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      {/* ── Toast ── */}
      {toast && (
        <div
          className={cn(
            'fixed bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-2 px-4 py-2 rounded-md text-xs font-medium shadow-lg animate-fade-in-up z-50',
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
