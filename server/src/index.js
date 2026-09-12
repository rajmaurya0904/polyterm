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

import { fetchBook, fetchHistory, fetchMarket, fetchTopMarkets, searchMarkets, toRows } from './polymarket.js';
import { createMarketSocket } from './socket.js';
import { createPaperStore } from './paper.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 4010;
const TOP_N = Number(process.env.TOP_MARKETS) || 24;
const BOOK_REFRESH_MS = Number(process.env.BOOK_REFRESH_MS) || 4000;
const BROADCAST_MS = 1000;

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

/** A last price outside the current spread is stale; the book wins. */
function isStale(row) {
  if (row.last == null || row.bid == null || row.ask == null) return false;
  return row.last < row.bid - 0.001 || row.last > row.ask + 0.001;
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
  const interval = String(req.query.interval || '1w');
  const history = await fetchHistory(req.params.tokenId, interval);
  res.json({ tokenId: req.params.tokenId, interval, history });
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
  if (!marketId) return res.status(400).json({ error: 'marketId required' });
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

app.post('/api/paper/reset', (req, res) => {
  paper.reset(Number(req.body?.balance) || undefined);
  broadcast();
  res.json({ ok: true });
});

// Serve the built front end when it exists, so `npm start` runs the whole app.
const dist = path.join(__dirname, '..', '..', 'web', 'dist');
app.use(express.static(dist));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

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

  setInterval(refreshBooks, BOOK_REFRESH_MS);
  setInterval(broadcast, BROADCAST_MS);

  server.listen(PORT, () => {
    console.log(`\n  PolyTerm API   http://localhost:${PORT}`);
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
