/**
 * Polymarket public data access.
 *
 * Three public endpoints, no credentials anywhere:
 *   Gamma  https://gamma-api.polymarket.com  market metadata & discovery
 *   CLOB   https://clob.polymarket.com       order books & price history
 *   WS     wss://ws-subscriptions-clob…      live trade/book pushes
 *
 * Read-only by construction: nothing here signs, authenticates, or places an
 * order. There is no code path to the trading API.
 */

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';

/** Gamma encodes several array fields as JSON strings. */
export function parseArr(raw) {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/**
 * Normalise a Gamma market into flat per-outcome rows.
 *
 * Gamma splits an outcome across three parallel arrays (`outcomes`,
 * `outcomePrices`, `clobTokenIds`); the UI wants one row per tradeable token.
 */
export function toRows(market, segment) {
  const names = parseArr(market.outcomes).map(String);
  const tokens = parseArr(market.clobTokenIds).map(String);
  const prices = parseArr(market.outcomePrices).map(Number);

  return tokens.map((tokenId, i) => ({
    tokenId,
    marketId: String(market.id),
    outcomeIndex: i,
    question: market.question,
    slug: market.slug,
    outcome: names[i] ?? String(i),
    category: SEGMENT_KEYS.has(segment) ? segment : categorise(market),
    indicative: Number.isFinite(prices[i]) ? prices[i] : null,
    volume24h: market.volume24hr || 0,
    liquidity: market.liquidityNum ?? Number(market.liquidity) ?? 0,
    endDate: market.endDate ?? null,
    // Live fields, filled in by the poller and socket.
    bid: null,
    ask: null,
    last: null,
    prevLast: null,
    book: null,
    resolved: false,
  }));
}

/**
 * Polymarket's top-level segments, in priority order.
 *
 * Tags on an event run from the canonical ("Politics") to the extremely
 * specific ("caitlin clark"), and they overlap heavily — the Fed decision
 * carries Politics, Economy, Business and Finance at once. So a market is
 * claimed by the first segment in this list that returns it, which makes the
 * order an editorial decision rather than an arbitrary one: the Fed lands in
 * ECONOMY because that is the desk that would trade it, not POLITICS.
 */
export const SEGMENTS = [
  { key: 'ECONOMY', slug: 'economy' },
  { key: 'POLITICS', slug: 'politics' },
  { key: 'CRYPTO', slug: 'crypto' },
  { key: 'SPORTS', slug: 'sports' },
  { key: 'WORLD', slug: 'world' },
  { key: 'TECH', slug: 'tech' },
  { key: 'SCIENCE', slug: 'science' },
  { key: 'CULTURE', slug: 'pop-culture' },
  { key: 'WEATHER', slug: 'weather' },
];

const SEGMENT_KEYS = new Set(SEGMENTS.map((s) => s.key));

/**
 * Fall back to reading the question when a market arrives without a segment —
 * from search, or from a /watch by id. Crude next to the real tags, but it
 * beats dropping everything into OTHER.
 */
export function categorise(market) {
  const text = `${market.question || ''} ${market.slug || ''}`.toLowerCase();
  if (/\b(fed|rate|cpi|inflation|gdp|recession|jobs|unemployment)\b/.test(text)) return 'ECONOMY';
  if (/\b(bitcoin|btc|ethereum|eth|solana|crypto|token)\b/.test(text)) return 'CRYPTO';
  if (/\b(election|president|senate|congress|nominee|parliament|minister)\b/.test(text)) return 'POLITICS';
  if (/\b(vs|game|match|win on|playoffs|cup|league|open)\b/.test(text)) return 'SPORTS';
  return 'OTHER';
}

/**
 * A last-trade price outside the current spread is stale and the book wins.
 *
 * The socket pushes trades faster than book snapshots, so on a fast market
 * `last` can sit outside a spread that has since moved. Showing it as a live
 * quote is worse than flagging it, because it reads as a price you could get.
 * The tolerance absorbs float noise, not genuine drift.
 */
export function isStale(row) {
  if (row.last == null || row.bid == null || row.ask == null) return false;
  return row.last < row.bid - 0.001 || row.last > row.ask + 0.001;
}

/**
 * Settlement payouts for a market, or null while it is still open.
 *
 * Gamma exposes several near-signals that are not the signal. `closed` flips
 * when trading halts, which can be days before the oracle rules. `resolvedBy`
 * is the oracle's address and is present on every market from birth. What
 * actually marks a ruling is `umaResolutionStatus === 'resolved'` together
 * with `outcomePrices` collapsing to exactly 0 or 1 per outcome — both are
 * required, because a status flip with prices still fractional would settle
 * positions at a probability rather than a payout.
 */
export function resolutionOf(market) {
  if (!market || market.umaResolutionStatus !== 'resolved') return null;
  const prices = parseArr(market.outcomePrices).map(Number);
  if (!prices.length) return null;
  if (!prices.every((p) => p === 0 || p === 1)) return null;
  if (!prices.some((p) => p === 1)) return null;
  return { payouts: prices };
}

/**
 * What the book can actually tell you about a price right now.
 *
 * A holder cares about one thing: is there a bid to sell into. "No book at
 * all" and "a book with eighty asks and nobody buying" both leave a position
 * unmarkable, but they are not the same fact and must not carry the same
 * label — the first is a gap in our data, the second is the market telling
 * you what your position is worth.
 *
 *   gone       resolved upstream; the book has been withdrawn
 *   none       never fetched, or the last fetch failed
 *   empty      book exists, both sides bare
 *   ask-only   offers but no bids — nothing to sell into
 *   bid-only   bids but no offers — nothing to buy
 *   two-sided  a real market
 */
export function quoteState(row) {
  if (row.resolved) return 'gone';
  if (!row.book) return 'none';
  const bids = row.book.bids.length > 0;
  const asks = row.book.asks.length > 0;
  if (bids && asks) return 'two-sided';
  if (asks) return 'ask-only';
  if (bids) return 'bid-only';
  return 'empty';
}

/**
 * Open markets in one segment, busiest first.
 *
 * Goes through /events rather than /markets because only an event carries the
 * tags; its markets are the individual tradeable questions underneath it.
 */
export async function fetchSegment(slug, limit = 20) {
  const url = `${GAMMA}/events?limit=${limit}&active=true&closed=false`
    + `&order=volume24hr&ascending=false&tag_slug=${encodeURIComponent(slug)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Gamma events ${slug}: HTTP ${res.status}`);
  const events = await res.json();
  const out = [];
  for (const event of Array.isArray(events) ? events : []) {
    for (const market of event.markets || []) {
      if (market.closed || !market.clobTokenIds) continue;
      out.push(market);
    }
  }
  return out;
}

/**
 * The whole board: every segment, busiest markets first within each.
 *
 * Two rules do the work here.
 *
 * A market tagged both Economy and Politics is claimed by whichever segment
 * comes first in SEGMENTS, so it appears exactly once.
 *
 * The outcome budget is then split evenly rather than spent in priority order.
 * That is the whole point: Politics and Sports alone offer several thousand
 * outcomes between them, so filling the board greedily buries every other
 * segment — nine segments went in and two came out. Each segment instead gets
 * an equal share, and only what a segment cannot use is redistributed to those
 * with more to give.
 *
 * A segment whose fetch fails is skipped rather than taking the rest down.
 */
export async function fetchUniverse({ perSegment = 20, maxOutcomes = 450, segments = SEGMENTS } = {}) {
  const results = await Promise.all(segments.map(async (segment) => {
    try {
      return { segment, markets: await fetchSegment(segment.slug, perSegment) };
    } catch {
      return { segment, markets: [] };
    }
  }));

  // Claim in priority order, so each market belongs to one segment only.
  const claimed = new Set();
  const queues = results.map(({ segment, markets }) => {
    const mine = [];
    for (const market of markets) {
      const id = String(market.id);
      if (claimed.has(id)) continue;
      claimed.add(id);
      mine.push(market);
    }
    return { segment, markets: mine, taken: 0 };
  });

  const share = Math.max(1, Math.floor(maxOutcomes / Math.max(queues.length, 1)));
  const out = [];
  let spent = 0;

  const drain = (queue, ceiling) => {
    while (queue.markets.length && queue.taken < ceiling && spent < maxOutcomes) {
      const market = queue.markets[0];
      const cost = parseArr(market.clobTokenIds).length;
      if (!cost) { queue.markets.shift(); continue; }
      if (spent + cost > maxOutcomes) break;
      queue.markets.shift();
      queue.taken += cost;
      spent += cost;
      out.push({ market, segment: queue.segment.key });
    }
  };

  for (const queue of queues) drain(queue, share);

  // Hand the remainder back out a slice at a time, so no single segment
  // swallows it the way Politics swallowed the whole board before.
  let progress = true;
  while (spent < maxOutcomes && progress) {
    progress = false;
    for (const queue of queues) {
      if (!queue.markets.length || spent >= maxOutcomes) continue;
      const before = spent;
      drain(queue, queue.taken + share);
      if (spent > before) progress = true;
    }
  }

  return out;
}

/** Largest token count the CLOB accepts in one /books call. */
const BOOK_CHUNK = 250;

/**
 * Books for many tokens at once.
 *
 * The bulk endpoint silently omits tokens it has no book for, so the result is
 * a Map and absence is the signal — the caller decides whether that means
 * resolved, delisted, or simply never traded. Fetching these one at a time
 * would be one request per outcome per refresh, which does not survive a board
 * of several hundred.
 */
export async function fetchBooks(tokenIds) {
  const found = new Map();
  for (let i = 0; i < tokenIds.length; i += BOOK_CHUNK) {
    const chunk = tokenIds.slice(i, i + BOOK_CHUNK);
    let raw;
    try {
      const res = await fetch(`${CLOB}/books`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(chunk.map((token_id) => ({ token_id }))),
      });
      if (!res.ok) continue;
      raw = await res.json();
    } catch {
      continue; // transient; the caller keeps the previous snapshot
    }
    for (const entry of Array.isArray(raw) ? raw : []) {
      if (!entry || !entry.asset_id) continue;
      found.set(String(entry.asset_id), {
        bids: levels(entry.bids, (a, b) => b[0] - a[0]),
        asks: levels(entry.asks, (a, b) => a[0] - b[0]),
        last: Number.parseFloat(entry.last_trade_price),
      });
    }
  }
  return found;
}

function levels(raw, sort) {
  return (raw || [])
    .map((x) => [Number.parseFloat(x.price), Number.parseFloat(x.size)])
    .filter(([p, sz]) => Number.isFinite(p) && Number.isFinite(sz))
    .sort(sort);
}

/** A single market by its Gamma numeric id. */
export async function fetchMarket(marketId) {
  const res = await fetch(`${GAMMA}/markets/${encodeURIComponent(marketId)}`);
  if (!res.ok) throw new Error(`Gamma market ${marketId}: HTTP ${res.status}`);
  return res.json();
}

/** Text search across markets. Gamma's /markets has no query param — this does. */
export async function searchMarkets(query, limit = 20) {
  const url = `${GAMMA}/public-search?q=${encodeURIComponent(query)}&limit_per_type=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Gamma search: HTTP ${res.status}`);
  const data = await res.json();
  const out = [];
  for (const event of data.events ?? []) {
    for (const market of event.markets ?? []) {
      if (market.closed) continue;
      out.push(market);
    }
  }
  return out.slice(0, limit);
}

/**
 * Order book for one outcome token.
 * Returns 'gone' for a resolved market whose book has been removed — a real
 * state the UI shows, distinct from a transport failure (null).
 */
export async function fetchBook(tokenId) {
  const res = await fetch(`${CLOB}/book?token_id=${encodeURIComponent(tokenId)}`);
  if (res.status === 404) return 'gone';
  if (!res.ok) return null;
  const raw = await res.json();

  const bids = (raw.bids || [])
    .map((x) => [Number.parseFloat(x.price), Number.parseFloat(x.size)])
    .filter(([p, s]) => Number.isFinite(p) && Number.isFinite(s))
    .sort((a, b) => b[0] - a[0]);
  const asks = (raw.asks || [])
    .map((x) => [Number.parseFloat(x.price), Number.parseFloat(x.size)])
    .filter(([p, s]) => Number.isFinite(p) && Number.isFinite(s))
    .sort((a, b) => a[0] - b[0]);

  return { bids, asks };
}

/** Historical price series for one token. */
export async function fetchHistory(tokenId, interval = '1w', fidelity = 60) {
  const url = `${CLOB}/prices-history?market=${encodeURIComponent(tokenId)}&interval=${interval}&fidelity=${fidelity}`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const data = await res.json();
  return (data.history || []).map((p) => ({ t: p.t * 1000, p: p.p }));
}
