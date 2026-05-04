import { useEffect, useState, useRef, useCallback } from 'react';
import {
  Pause,
  Play,
  Trash2,
  Activity,
  Link2,
  Webhook,
} from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { useWebSocket } from '../useWebSocket';
import { callbackApi } from '../api';
import type { WsMessage } from '../types';
import { wsMessageText } from '../types';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/* ──────────── helpers ──────────── */

function formatTime(ts: number | undefined): string {
  const d = ts ? (ts < 1e12 ? new Date(ts * 1000) : new Date(ts)) : new Date();
  return d.toLocaleTimeString('zh-CN', { hour12: false });
}

function truncate(str: string | undefined | null, max: number): string {
  if (!str) return '';
  return str.length > max ? str.slice(0, max) + '…' : str;
}

function entityId(msg: WsMessage): string {
  if (msg.task) return msg.task.id || '?';
  if (msg.run) return msg.run.runId || msg.run.taskId || '?';
  if (msg.session) return msg.session.id || '?';
  if (msg.sessionId) return msg.sessionId;
  return '';
}

function entityDescription(msg: WsMessage): string {
  if (msg.task) {
    const t = msg.task;
    return `→ ${t.status || '?'}${t.error ? ` (${truncate(t.error, 40)})` : ''}`;
  }
  if (msg.run) {
    const r = msg.run;
    return `→ ${r.status || '?'}${r.error ? ` (${truncate(r.error, 40)})` : ''}`;
  }
  if (msg.session) {
    return `[${msg.session.cliType ?? 'unknown'}] ${msg.session.status || '?'}`;
  }
  if (msg.data) {
    return truncate(String(msg.data), 60);
  }
  if (msg.message) {
    return truncate(wsMessageText(msg.message), 60);
  }
  return '';
}

/* ──────────── event type filter tabs ──────────── */

type EventTab = 'ALL' | 'task_updated' | 'task_added' | 'task_submitted' | 'run_event' | 'session_output' | 'session_message';

const EVENT_TABS: { key: EventTab; label: string }[] = [
  { key: 'ALL', label: 'ALL' },
  { key: 'task_updated', label: 'task_updated' },
  { key: 'task_added', label: 'task_added' },
  { key: 'task_submitted', label: 'task_submitted' },
  { key: 'run_event', label: 'run_event' },
  { key: 'session_output', label: 'session_output' },
  { key: 'session_message', label: 'session_message' },
];

/* ──────────── bottom bridge tabs ──────────── */

type BridgeTab = 'feishu' | 'openclaw' | 'callbacks';

const BRIDGE_TABS: { key: BridgeTab; label: string; icon: typeof Link2 }[] = [
  { key: 'feishu', label: '飞书桥接', icon: Link2 },
  { key: 'openclaw', label: 'OpenClaw 桥接', icon: Link2 },
  { key: 'callbacks', label: 'Callbacks', icon: Webhook },
];

/* ──────────── Monitor page ──────────── */

export default function Monitor() {
  const { messages, connected, clearMessages } = useWebSocket();
  const [paused, setPaused] = useState(false);
  const [eventTab, setEventTab] = useState<EventTab>('ALL');
  const [bridgeTab, setBridgeTab] = useState<BridgeTab>('feishu');
  const [callbacks, setCallbacks] = useState<unknown[]>([]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  /* ── fetch callbacks on mount ── */
  useEffect(() => {
    callbackApi
      .list()
      .then((res) => {
        if (res.ok && res.callbacks) setCallbacks(res.callbacks);
      })
      .catch(() => {});
  }, []);

  /* ── filtered messages for main log ── */
  const filteredMessages =
    eventTab === 'ALL'
      ? messages
      : messages.filter((m) => m.type === eventTab);

  /* ── auto-scroll (only when not paused) ── */
  useEffect(() => {
    if (!paused) {
      sentinelRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [filteredMessages, paused]);

  /* ── bridge-related WS messages ── */
  const bridgeMessages = messages.filter(
    (m) =>
      m.type === 'session_output' ||
      m.type === 'session_message' ||
      m.type === 'session_registered' ||
      m.type === 'session_exit'
  );

  /* ── handle clear ── */
  const handleClear = useCallback(() => {
    clearMessages();
  }, [clearMessages]);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* ── Top Bar ── */}
      <div className="shrink-0 px-5 pt-4 pb-2 flex items-center gap-4">
        {/* WS Status */}
        <div className="flex items-center gap-2">
          <span className={connected ? 'status-dot active' : 'status-dot danger'} />
          <span
            className={cn(
              'text-xs font-heading tracking-wider',
              connected
                ? 'text-[var(--color-accent)] text-glow'
                : 'text-[var(--color-danger)]'
            )}
          >
            {connected ? 'WS CONNECTED' : 'DISCONNECTED'}
          </span>
        </div>

        <div className="flex-1" />

        {/* Pause / Resume */}
        <button
          onClick={() => setPaused((p) => !p)}
          className={cn(
            'flex items-center gap-1.5 px-3 py-1.5 rounded text-xs transition-colors',
            paused
              ? 'bg-[var(--color-warning)] text-[var(--color-bg)] hover:opacity-90'
              : 'panel hover:bg-[var(--color-accent-dim)] text-[var(--color-text-primary)]'
          )}
        >
          {paused ? <Play size={14} strokeWidth={1.5} /> : <Pause size={14} strokeWidth={1.5} />}
          {paused ? 'Resume' : 'Pause'}
        </button>

        {/* Clear */}
        <button
          onClick={handleClear}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs panel hover:bg-[var(--color-danger)] hover:text-white transition-colors text-[var(--color-text-primary)]"
        >
          <Trash2 size={14} strokeWidth={1.5} />
          Clear
        </button>
      </div>

      {/* ── Event Type Tabs ── */}
      <div className="shrink-0 px-5 flex items-center gap-1 border-b border-[var(--color-border)]">
        {EVENT_TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setEventTab(tab.key)}
            className={cn(
              'px-3 py-2 text-xs font-body tracking-wide transition-colors relative',
              eventTab === tab.key
                ? 'text-[var(--color-accent)]'
                : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
            )}
          >
            {tab.label}
            {eventTab === tab.key && (
              <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-[var(--color-accent)]" />
            )}
          </button>
        ))}
        <span className="ml-auto text-xs text-[var(--color-text-secondary)] py-2">
          {filteredMessages.length} events
        </span>
      </div>

      {/* ── Main Event Log ── */}
      <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
        <div
          ref={scrollRef}
          className="flex-1 overflow-y-auto mono-log px-5 py-3"
        >
          {filteredMessages.length === 0 ? (
            <div className="flex items-center h-full text-[var(--color-text-secondary)] text-xs">
              <Activity size={14} strokeWidth={1.5} className="mr-2" />
              <span>Waiting for events…</span>
              <span className="cursor-blink ml-1 text-[var(--color-accent)]">█</span>
            </div>
          ) : (
            <>
              {filteredMessages.map((msg, i) => (
                <div
                  key={i}
                  className="flex items-start gap-2 hover:bg-[var(--color-accent-dim)] transition-colors leading-6 animate-fade-in-up"
                >
                  <span className="text-[var(--color-text-secondary)] shrink-0 w-16">
                    {formatTime(msg.timestamp)}
                  </span>
                  <span className="text-[var(--color-warning)] shrink-0 w-32 truncate">
                    {msg.type}
                  </span>
                  <span className="text-[var(--color-accent)] shrink-0 w-28 truncate">
                    {entityId(msg)}
                  </span>
                  <span className="text-[var(--color-text-primary)]">
                    {entityDescription(msg)}
                  </span>
                </div>
              ))}
              <div ref={sentinelRef} />
              <span className="cursor-blink text-[var(--color-accent)]">█</span>
            </>
          )}
        </div>
      </div>

      {/* ── Bottom Section: Bridge & Callbacks ── */}
      <div className="shrink-0 border-t border-[var(--color-border)] flex flex-col max-h-[40%]">
        {/* Bridge Tabs */}
        <div className="flex items-center gap-1 px-5 border-b border-[var(--color-border)]">
          {BRIDGE_TABS.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.key}
                onClick={() => setBridgeTab(tab.key)}
                className={cn(
                  'flex items-center gap-1.5 px-3 py-2 text-xs font-body tracking-wide transition-colors relative',
                  bridgeTab === tab.key
                    ? 'text-[var(--color-accent)]'
                    : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
                )}
              >
                <Icon size={12} strokeWidth={1.5} />
                {tab.label}
                {bridgeTab === tab.key && (
                  <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-[var(--color-accent)]" />
                )}
              </button>
            );
          })}
        </div>

        {/* Bridge / Callback Content */}
        <div className="flex-1 overflow-y-auto mono-log px-5 py-2 min-h-[80px]">
          {bridgeTab === 'callbacks' && (
            <>
              {callbacks.length === 0 ? (
                <div className="text-[var(--color-text-secondary)] text-xs">
                  No callback records
                </div>
              ) : (
                callbacks.map((cb, i) => (
                  <div
                    key={i}
                    className="text-[var(--color-accent)] leading-6 hover:bg-[var(--color-accent-dim)] transition-colors"
                  >
                    <span className="text-[var(--color-text-secondary)] mr-2">
                      {typeof cb === 'object' && cb !== null && 'timestamp' in cb
                        ? formatTime((cb as { timestamp: number }).timestamp)
                        : '--:--:--'}
                    </span>
                    <span>
                      {typeof cb === 'object' && cb !== null && 'payload' in cb
                        ? truncate(JSON.stringify((cb as { payload: unknown }).payload), 100)
                        : truncate(JSON.stringify(cb), 100)}
                    </span>
                  </div>
                ))
              )}
            </>
          )}

          {bridgeTab === 'feishu' && (
            <>
              {bridgeMessages.length === 0 ? (
                <div className="text-[var(--color-text-secondary)] text-xs">
                  No Feishu bridge events yet
                </div>
              ) : (
                bridgeMessages.map((msg, i) => (
                  <div
                    key={i}
                    className="text-[var(--color-accent)] leading-6 hover:bg-[var(--color-accent-dim)] transition-colors"
                  >
                    <span className="text-[var(--color-text-secondary)] mr-2">
                      {formatTime(msg.timestamp)}
                    </span>
                    <span className="text-[var(--color-warning)] mr-2">{msg.type}</span>
                    <span>{entityId(msg)} {entityDescription(msg)}</span>
                  </div>
                ))
              )}
            </>
          )}

          {bridgeTab === 'openclaw' && (
            <>
              {bridgeMessages.length === 0 ? (
                <div className="text-[var(--color-text-secondary)] text-xs">
                  No OpenClaw bridge events yet
                </div>
              ) : (
                bridgeMessages.map((msg, i) => (
                  <div
                    key={i}
                    className="text-[var(--color-accent)] leading-6 hover:bg-[var(--color-accent-dim)] transition-colors"
                  >
                    <span className="text-[var(--color-text-secondary)] mr-2">
                      {formatTime(msg.timestamp)}
                    </span>
                    <span className="text-[var(--color-warning)] mr-2">{msg.type}</span>
                    <span>{entityId(msg)} {entityDescription(msg)}</span>
                  </div>
                ))
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
