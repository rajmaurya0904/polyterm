import { useEffect, useState } from 'react';
import type { Snapshot } from '../types';

const RETRY_MS = 1500;

/**
 * Subscribe to the server's relay socket.
 *
 * Reconnects on its own, so a server restart heals without a page reload.
 * `connected` describes this browser's link to the relay; `snapshot.status`
 * describes the relay's link to the exchange — they fail independently and
 * the UI shows both.
 */
export function useLiveSnapshot() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let socket: WebSocket | null = null;
    let timer: number | undefined;

    const open = () => {
      if (cancelled) return;
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${proto}//${location.host}/ws`);
      socket = ws;

      ws.addEventListener('open', () => {
        // React's StrictMode mounts, unmounts and remounts in development, so
        // this can resolve after teardown. Closing a socket while it is still
        // CONNECTING aborts the handshake, so the close is deferred to here.
        if (cancelled) { ws.close(); return; }
        setConnected(true);
      });

      ws.addEventListener('message', (event) => {
        if (cancelled) return;
        try {
          setSnapshot(JSON.parse(event.data) as Snapshot);
        } catch {
          // Drop a malformed frame rather than tearing down the socket.
        }
      });

      ws.addEventListener('close', () => {
        if (cancelled) return;
        setConnected(false);
        timer = window.setTimeout(open, RETRY_MS);
      });

      // 'error' is always followed by 'close', which owns the reconnect.
      ws.addEventListener('error', () => {});
    };

    open();

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      if (!socket) return;
      if (socket.readyState === WebSocket.OPEN) socket.close();
      // A CONNECTING socket is closed by its own open handler above.
    };
  }, []);

  return { snapshot, connected };
}
