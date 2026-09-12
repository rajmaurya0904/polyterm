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
export function toRows(market) {
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
    category: categorise(market),
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
 * Bucket a market into a display group. Polymarket has no first-class category
 * field, so this keys off the question text — crude, but it drives grouping
 * the way product families do on a commodities desk.
 */
export function categorise(market) {
  const text = `${market.question || ''} ${market.slug || ''}`.toLowerCase();
  if (/\b(fed|rate|cpi|inflation|gdp|recession|jobs|unemployment)\b/.test(text)) return 'MACRO';
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

/** Top active markets by 24h volume. */
export async function fetchTopMarkets(limit = 20) {
  const url = `${GAMMA}/markets?limit=${limit}&active=true&closed=false&order=volume24hr&ascending=false`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Gamma markets: HTTP ${res.status}`);
  return res.json();
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
