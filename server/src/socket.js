/**
 * Upstream Polymarket market socket.
 *
 * A browser cannot hold this connection itself, so the server owns one socket
 * and fans updates out to every connected client. Reconnects with capped
 * exponential backoff and re-subscribes on reconnect.
 */

import WebSocket from 'ws';

const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const MAX_BACKOFF_MS = 30_000;

export function createMarketSocket({ onTrade, onBook, onStatus }) {
  let ws = null;
  let assetIds = [];
  let attempt = 0;
  let reconnectTimer = null;
  let closed = false;

  const status = (s) => { if (onStatus) onStatus(s); };

  function subscribe() {
    if (!ws || ws.readyState !== WebSocket.OPEN || !assetIds.length) return;
    ws.send(JSON.stringify({ type: 'market', assets_ids: assetIds, initial_dump: true }));
  }

  function handle(raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    // The feed sends either a single event or a batch.
    const events = Array.isArray(msg) ? msg : [msg];
    for (const ev of events) {
      const assetId = ev.asset_id || ev.market;
      if (!assetId) continue;

      if (ev.event_type === 'book' && (ev.bids || ev.asks)) {
        const bids = (ev.bids || [])
          .map((x) => [Number.parseFloat(x.price), Number.parseFloat(x.size)])
          .filter(([p, s]) => Number.isFinite(p) && Number.isFinite(s))
          .sort((a, b) => b[0] - a[0]);
        const asks = (ev.asks || [])
          .map((x) => [Number.parseFloat(x.price), Number.parseFloat(x.size)])
          .filter(([p, s]) => Number.isFinite(p) && Number.isFinite(s))
          .sort((a, b) => a[0] - b[0]);
        if (onBook) onBook(assetId, { bids, asks });
        continue;
      }

      if (ev.event_type === 'last_trade_price' || ev.event_type === 'price_change') {
        const price = Number.parseFloat(ev.price);
        if (Number.isFinite(price) && onTrade) onTrade(assetId, price);
      }
    }
  }

  function connect() {
    if (closed || ws) return;
    status('connecting');
    const socket = new WebSocket(WS_URL);
    ws = socket;

    socket.on('open', () => {
      if (ws !== socket) { try { socket.close(); } catch { /* superseded */ } return; }
      attempt = 0;
      status('live');
      subscribe();
    });

    socket.on('message', handle);

    socket.on('close', () => {
      if (ws !== socket) return;
      ws = null;
      status('reconnecting');
      scheduleReconnect();
    });

    // 'error' is always followed by 'close'; reconnect is handled there.
    socket.on('error', () => {});
  }

  function scheduleReconnect() {
    if (closed || reconnectTimer) return;
    const delay = Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS);
    attempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  return {
    start(ids) {
      assetIds = [...new Set(ids)];
      connect();
    },
    setAssets(ids) {
      assetIds = [...new Set(ids)];
      subscribe();
    },
    stop() {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) { try { ws.close(); } catch { /* already gone */ } }
      ws = null;
    },
  };
}
