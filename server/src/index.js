/**
 * PolyTerm server — data relay and paper-trading API.
 *
 * Owns the upstream Polymarket socket and fans state out to browser clients
 * over a local WebSocket. The browser cannot reach the exchange feed directly
 * (page CSP and the exchange's own origin rules both prevent it), so this
 * process sits in between.
 */

import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import {
  fetchBook, fetchHistory, fetchMarket, fetchTopMarkets, isStale, quoteState, resolutionOf,
  searchMarkets, toRows,
} from './polymarket.js';
import { createMarketSocket } from './socket.js';
import { createPaperStore } from './paper.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 4010;
// Loopback by default. Set HOST=0.0.0.0 to expose on the LAN — there is no
// auth, so anyone who can reach the port can move the paper account.
const HOST = process.env.HOST || '127.0.0.1';
const TOP_N = Number(process.env.TOP_MARKETS) || 24;
const BOOK_REFRESH_MS = Number(process.env.BOOK_REFRESH_MS) || 4000;
const BROADCAST_MS = 1000;
// Every watched outcome costs one book request per refresh, so the watch set
// has to be bounded or a loop of /api/watch calls becomes a request storm.
const MAX_OUTCOMES = Number(process.env.MAX_OUTCOMES) || 200;
// How often held markets are asked whether the oracle has ruled. Resolution
// takes hours to days, so a minute is generous; it is one request per held
// market, not per outcome.
const SETTLE_CHECK_MS = Number(process.env.SETTLE_CHECK_MS) || 60_000;

const ID_RE = /^\d{1,80}$/; // Gamma market ids and CLOB token ids are decimal strings
const INTERVALS = new Set(['1h', '6h', '1d', '1w', '1m', 'max']);

const paper = createPaperStore(path.join(__dirname, '..', '..', 'data', 'paper.json'));

/** tokenId -> row */
const rows = new Map();
let feedStatus = 'starting';
let ticks = 0;

function rowList() {
  return [...rows.values()];
}

function addMarket(market) {
  const added = [];
  for (const row of toRows(market)) {
    if (rows.has(row.tokenId)) continue;
    rows.set(row.tokenId, row);
    added.push(row);
  }
  return added;
}

const socket = createMarketSocket({
  onStatus: (s) => { feedStatus = s; },
  onTrade: (assetId, price) => {
    const row = rows.get(assetId);
    if (!row) return;
    row.prevLast = row.last;
    row.last = price;
    ticks += 1;
  },
  onBook: (assetId, book) => {
    const row = rows.get(assetId);
    if (!row || (!book.bids.length && !book.asks.length)) return;
    row.book = book;
    row.bid = book.bids.length ? book.bids[0][0] : null;
    row.ask = book.asks.length ? book.asks[0][0] : null;
    ticks += 1;
  },
});

/**
 * Poll books over REST as well as taking socket pushes.
 *
 * The socket carries trades reliably but book snapshots only intermittently,
 * and its last-trade price can drift outside the current spread on fast
 * markets. REST is the authority for depth; the socket supplies immediacy.
 */
async function refreshBooks() {
  await Promise.all(rowList().map(async (row) => {
    try {
      const book = await fetchBook(row.tokenId);
      if (book === 'gone') { row.resolved = true; row.book = null; row.bid = null; row.ask = null; return; }
      if (!book) return;
      row.resolved = false;
      row.book = book;
      row.bid = book.bids.length ? book.bids[0][0] : null;
      row.ask = book.asks.length ? book.asks[0][0] : null;
      if (row.last == null && row.bid != null) row.last = row.bid;
    } catch {
      // Transient network failure — keep the previous snapshot.
    }
  }));
}

/**
 * Settle positions whose market has resolved.
 *
 * A resolved market's book is simply gone upstream, so without this a held
 * position would sit unmarked forever and the account would never see the
 * $1.00 or $0.00 it is actually worth. Asks Gamma about each held market and
 * pays out any that the oracle has ruled on.
 */
let settling = false;
async function checkSettlements() {
  if (settling) return 0;
  settling = true;
  let settled = 0;
  try {
    const held = paper.positions();
    const marketIds = [...new Set(held.map((p) => p.marketId))];
    for (const marketId of marketIds) {
      let resolution;
      try {
        resolution = resolutionOf(await fetchMarket(marketId));
      } catch {
        continue; // transient; next tick will ask again
      }
      if (!resolution) continue;

      for (const position of held.filter((p) => p.marketId === marketId)) {
        const payout = resolution.payouts[position.outcomeIndex];
        if (payout !== 0 && payout !== 1) continue;
        const result = paper.settle(position.tokenId, payout);
        if (!result.ok) continue;
        settled += 1;
        console.log(
          `Settled ${position.shares} × "${position.outcome}" on "${position.question}" at $${payout}.00`
          + ` (realized ${result.trade.realized >= 0 ? '+' : ''}${result.trade.realized.toFixed(2)})`,
        );
      }
      // Every row of this market now has a known terminal price.
      for (const row of rowList()) {
        if (row.marketId !== marketId) continue;
        row.resolved = true;
        row.payout = resolution.payouts[row.outcomeIndex] ?? null;
        row.book = null; row.bid = null; row.ask = null;
      }
    }
  } finally {
    settling = false;
  }
  if (settled) broadcast();
  return settled;
}

function snapshot() {
  const list = rowList();
  const marked = paper.positions().map((p) => {
    const row = rows.get(p.tokenId);
    const mark = row ? row.bid : null;
    return {
      ...p,
      mark,
      unrealized: mark != null ? (mark - p.avgCost) * p.shares : null,
      resolved: row?.resolved ?? false,
      // Why there is no mark, so the UI can say which it is.
      quote: row ? quoteState(row) : 'none',
    };
  });

  return {
    at: Date.now(),
    status: feedStatus,
    ticks,
    rows: list.map((r) => ({
      tokenId: r.tokenId,
      marketId: r.marketId,
      outcomeIndex: r.outcomeIndex,
      question: r.question,
      slug: r.slug,
      outcome: r.outcome,
      category: r.category,
      bid: r.bid,
      ask: r.ask,
      last: r.last,
      prevLast: r.prevLast,
      stale: isStale(r),
      spread: r.bid != null && r.ask != null ? +(r.ask - r.bid).toFixed(4) : null,
      volume24h: r.volume24h,
      liquidity: r.liquidity,
      resolved: r.resolved,
      payout: r.payout ?? null,
      quote: quoteState(r),
      book: r.book ? { bids: r.book.bids.slice(0, 8), asks: r.book.asks.slice(0, 8) } : null,
      held: marked.some((p) => p.tokenId === r.tokenId),
    })),
    positions: marked,
    account: paper.state,
  };
}

const app = express();
app.use(express.json());

app.get('/api/state', (_req, res) => res.json(snapshot()));

app.get('/api/history/:tokenId', async (req, res) => {
  const { tokenId } = req.params;
  if (!ID_RE.test(tokenId)) return res.status(400).json({ error: 'invalid tokenId' });
  const interval = String(req.query.interval || '1w');
  if (!INTERVALS.has(interval)) return res.status(400).json({ error: 'invalid interval' });
  const history = await fetchHistory(tokenId, interval);
  res.json({ tokenId, interval, history });
});

app.get('/api/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ markets: [] });
  try {
    const markets = await searchMarkets(q, 20);
    res.json({
      markets: markets.map((m) => ({
        id: String(m.id),
        question: m.question,
        slug: m.slug,
        volume24h: m.volume24hr || 0,
        watched: toRows(m).some((r) => rows.has(r.tokenId)),
      })),
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/** Add a market to the watch set by Gamma id. */
app.post('/api/watch', async (req, res) => {
  const marketId = String(req.body?.marketId || '');
  if (!ID_RE.test(marketId)) return res.status(400).json({ error: 'marketId must be a numeric Gamma id' });
  if (rows.size >= MAX_OUTCOMES) {
    return res.status(429).json({ error: `watch limit reached (${MAX_OUTCOMES} outcomes)` });
  }
  try {
    const market = await fetchMarket(marketId);
    const added = addMarket(market);
    if (added.length) {
      socket.setAssets(rowList().map((r) => r.tokenId));
      await refreshBooks();
    }
    res.json({ added: added.length });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post('/api/paper/order', (req, res) => {
  const { tokenId, side, shares, limit } = req.body || {};
  if (side !== 'buy' && side !== 'sell') return res.status(400).json({ error: 'side must be buy or sell' });
  const result = paper.place({
    row: rows.get(String(tokenId)),
    side,
    shares: Number(shares),
    limit: limit == null || limit === '' ? null : Number(limit),
  });
  if (!result.ok) return res.status(400).json({ error: result.reason });
  broadcast();
  res.json(result);
});

app.get('/api/paper/trades', (_req, res) => res.json({ trades: paper.trades() }));

/** Ask now rather than waiting for the next scheduled check. */
app.post('/api/paper/settle', async (_req, res) => {
  const settled = await checkSettlements();
  res.json({ settled });
});

app.post('/api/paper/reset', (req, res) => {
  const raw = req.body?.balance;
  let balance;
  if (raw != null && raw !== '') {
    balance = Number(raw);
    if (!Number.isFinite(balance) || balance <= 0 || balance > 1e9) {
      return res.status(400).json({ error: 'balance must be between 0 and 1,000,000,000' });
    }
  }
  paper.reset(balance);
  broadcast();
  res.json({ ok: true });
});

// Serve the built front end when it exists, so `npm start` runs the whole app.
const dist = path.join(__dirname, '..', '..', 'web', 'dist');
app.use(express.static(dist));

const server = http.createServer(app);

/**
 * Only pages served from this host (or the Vite dev server proxying for it)
 * may open the relay socket. Browsers do not apply CORS to WebSockets, so
 * without this any site open in the same browser could read the feed.
 */
function originAllowed(origin) {
  if (!origin) return true; // non-browser clients (curl, scripts) send no Origin
  try {
    const { hostname } = new URL(origin);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === HOST;
  } catch {
    return false;
  }
}

const wss = new WebSocketServer({
  server,
  verifyClient: ({ origin }) => originAllowed(origin),
});

function broadcast() {
  if (!wss.clients.size) return;
  const payload = JSON.stringify(snapshot());
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(payload);
  }
}

wss.on('connection', (client) => {
  client.send(JSON.stringify(snapshot()));
});

async function main() {
  console.log('Loading markets…');
  const markets = await fetchTopMarkets(TOP_N);
  for (const market of markets) addMarket(market);

  // Anything already held must be watched, or positions cannot be marked.
  for (const position of paper.positions()) {
    if (rows.has(position.tokenId)) continue;
    try {
      addMarket(await fetchMarket(position.marketId));
    } catch {
      // Market gone; the position shows without a mark.
    }
  }

  console.log(`Watching ${rows.size} outcomes across ${markets.length} markets.`);
  socket.start(rowList().map((r) => r.tokenId));
  await refreshBooks();

  // A market may have resolved while this process was down.
  const settledAtStart = await checkSettlements();
  if (settledAtStart) console.log(`Settled ${settledAtStart} position(s) that resolved while offline.`);

  setInterval(refreshBooks, BOOK_REFRESH_MS);
  setInterval(checkSettlements, SETTLE_CHECK_MS);
  setInterval(broadcast, BROADCAST_MS);

  server.listen(PORT, HOST, () => {
    console.log(`\n  PolyTerm API   http://${HOST}:${PORT}`);
    console.log(`  Web (dev)      http://localhost:5173\n`);
  });
}

function shutdown() {
  socket.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch((err) => {
  console.error('Failed to start:', err.message);
  process.exit(1);
});
