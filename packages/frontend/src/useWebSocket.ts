import { useEffect, useState, useCallback, useMemo } from 'react';
import type { WsMessage } from './types';

const WS_URL = import.meta.env.VITE_WS_URL || (import.meta.env.DEV ? `ws://${window.location.host}/ws` : 'ws://localhost:8701');

type Listener = (msg: WsMessage) => void;
type ConnectionListener = (connected: boolean) => void;

class WsManager {
  private socket: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private connectionListeners = new Set<ConnectionListener>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldReconnect = true;
  private connectAttempts = 0;

  get isConnected() {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  connect() {
    if (typeof WebSocket === 'undefined') return;
    if (
      this.socket?.readyState === WebSocket.OPEN ||
      this.socket?.readyState === WebSocket.CONNECTING
    )
      return;
    this.shouldReconnect = true;

    try {
      this.socket = new WebSocket(WS_URL);
    } catch (err) {
      console.warn('[WS] Failed to create WebSocket:', err);
      this.scheduleReconnect();
      return;
    }

    this.socket.onopen = () => {
      this.connectAttempts = 0;
      this.connectionListeners.forEach((cb) => cb(true));
      console.log('[WS] Connected');
    };

    this.socket.onclose = () => {
      this.connectionListeners.forEach((cb) => cb(false));
      this.socket = null;
      console.log('[WS] Disconnected');
      this.scheduleReconnect();
    };

    this.socket.onerror = () => {
      this.connectionListeners.forEach((cb) => cb(false));
    };

    this.socket.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data) as WsMessage;
        this.listeners.forEach((cb) => cb(msg));
      } catch {
        // ignore non-JSON messages
      }
    };
  }

  private scheduleReconnect() {
    if (!this.shouldReconnect) return;
    this.connectAttempts++;
    // Exponential backoff: 1s, 2s, 4s, 8s, ... max 30s
    const delay = Math.min(1000 * Math.pow(2, this.connectAttempts - 1), 30000);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  disconnect() {
    this.shouldReconnect = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.close();
    this.socket = null;
  }

  send(msg: object) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(msg));
    } else {
      console.warn('[WS] Not connected, message dropped');
    }
  }

  subscribe(listener: Listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeConnection(listener: ConnectionListener) {
    this.connectionListeners.add(listener);
    return () => this.connectionListeners.delete(listener);
  }
}

const wsManager = new WsManager();
wsManager.connect();

export function useWebSocket() {
  const [messages, setMessages] = useState<WsMessage[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    setConnected(wsManager.isConnected);
    const unsubMsg = wsManager.subscribe((msg) => {
      setMessages((prev) => [...prev, msg]);
    });
    const unsubConn = wsManager.subscribeConnection(setConnected);
    return () => {
      unsubMsg();
      unsubConn();
    };
  }, []);

  const send = useCallback((msg: object) => wsManager.send(msg), []);
  const clearMessages = useCallback(() => setMessages([]), []);

  return { messages, send, connected, clearMessages };
}

export function useWsMessages(typeFilter?: string | string[]) {
  const { messages, send, connected, clearMessages } = useWebSocket();
  const filters = useMemo(() => {
    if (!typeFilter) return null;
    return Array.isArray(typeFilter) ? typeFilter : [typeFilter];
  }, [typeFilter]);
  const filtered = useMemo(
    () => (filters ? messages.filter((m) => filters.includes(m.type)) : messages),
    [messages, filters],
  );
  return { messages: filtered, send, connected, clearMessages };
}
