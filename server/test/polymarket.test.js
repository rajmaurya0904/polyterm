/**
 * Normalisation tests for the Polymarket adapter.
 *
 * These cover the pure half: turning the upstream payload into rows, bucketing
 * markets, and judging whether a last-trade price is still meaningful. The
 * fetch half needs the network and is exercised by running the server.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  categorise, fetchUniverse, isStale, parseArr, quoteState, resolutionOf, SEGMENTS, toRows,
} from '../src/polymarket.js';

describe('parseArr — Gamma encodes arrays as JSON strings', () => {
  it('parses a JSON-encoded array', () => {
    assert.deepEqual(parseArr('["Yes","No"]'), ['Yes', 'No']);
  });

  it('returns empty for missing, malformed or non-array input', () => {
    for (const input of [undefined, null, '', 'not json', '{"a":1}', '42', '"str"']) {
      assert.deepEqual(parseArr(input), [], `input: ${JSON.stringify(input)}`);
    }
  });
});

describe('toRows — one row per tradeable token', () => {
  const market = {
    id: 12345,
    question: 'Will BTC close above $100k?',
    slug: 'btc-100k',
    outcomes: '["Yes","No"]',
    clobTokenIds: '["tok-yes","tok-no"]',
    outcomePrices: '["0.62","0.38"]',
    volume24hr: 1234.5,
    liquidityNum: 999,
    endDate: '2026-12-31T00:00:00Z',
  };

  it('emits one row per token with the parallel arrays zipped', () => {
    const rows = toRows(market);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.tokenId), ['tok-yes', 'tok-no']);
    assert.deepEqual(rows.map((r) => r.outcome), ['Yes', 'No']);
    assert.deepEqual(rows.map((r) => r.outcomeIndex), [0, 1]);
    assert.deepEqual(rows.map((r) => r.indicative), [0.62, 0.38]);
  });

  it('stringifies the market id, because Gamma sends a number', () => {
    const [r] = toRows(market);
    assert.equal(r.marketId, '12345');
    assert.equal(typeof r.marketId, 'string');
  });

  it('starts every live field empty, for the feed to fill in', () => {
    const [r] = toRows(market);
    assert.deepEqual(
      { bid: r.bid, ask: r.ask, last: r.last, book: r.book, resolved: r.resolved },
      { bid: null, ask: null, last: null, book: null, resolved: false },
    );
  });

  it('produces nothing when there are no clob tokens', () => {
    assert.deepEqual(toRows({ ...market, clobTokenIds: undefined }), []);
  });

  it('falls back to the index when an outcome has no name', () => {
    const rows = toRows({ ...market, outcomes: '["Yes"]' });
    assert.equal(rows[1].outcome, '1');
  });

  it('treats an unparseable price as unknown rather than zero', () => {
    const rows = toRows({ ...market, outcomePrices: '["abc","0.38"]' });
    assert.equal(rows[0].indicative, null, 'unknown is not zero');
    assert.equal(rows[1].indicative, 0.38);
  });

  it('defaults a missing volume to zero', () => {
    assert.equal(toRows({ ...market, volume24hr: undefined })[0].volume24h, 0);
  });
});

describe('categorise', () => {
  const cases = [
    ['Will the Fed cut rates in March?', 'ECONOMY'],
    ['Will CPI come in above 3%?', 'ECONOMY'],
    ['Will Bitcoin reach $95,000 in September?', 'CRYPTO'],
    ['Will ETH flip BTC?', 'CRYPTO'],
    ['Who will win the 2028 presidential election?', 'POLITICS'],
    ['Will the Senate confirm the nominee?', 'POLITICS'],
    ['Lakers vs Celtics', 'SPORTS'],
    ['Will Djokovic win the US Open?', 'SPORTS'],
    ['Will aliens be confirmed to exist?', 'OTHER'],
  ];

  for (const [question, expected] of cases) {
    it(`${expected} — ${question}`, () => {
      assert.equal(categorise({ question }), expected);
    });
  }

  it('reads the slug as well as the question', () => {
    assert.equal(categorise({ question: 'Will it happen?', slug: 'bitcoin-100k' }), 'CRYPTO');
  });

  it('matches on whole words only', () => {
    // "rate" must not fire on "grateful", or half the board lands in ECONOMY.
    assert.equal(categorise({ question: 'Will anyone be grateful?' }), 'OTHER');
  });

  it('survives a market with no text at all', () => {
    assert.equal(categorise({}), 'OTHER');
  });
});

describe('resolutionOf — only a ruled market pays out', () => {
  // Shapes copied from live Gamma responses, not invented.
  const resolved = {
    closed: true, active: true, umaResolutionStatus: 'resolved',
    resolvedBy: '0x65070BE9', outcomes: '["A","B"]', outcomePrices: '["0", "1"]',
  };
  const open = {
    closed: false, active: true, resolvedBy: '0x69c47De9',
    outcomes: '["Yes","No"]', outcomePrices: '["0.195", "0.805"]',
  };

  it('pays the winner 1 and the loser 0', () => {
    assert.deepEqual(resolutionOf(resolved), { payouts: [0, 1] });
  });

  it('is null for an open market', () => {
    assert.equal(resolutionOf(open), null);
  });

  it('ignores resolvedBy — it is the oracle address, present from birth', () => {
    assert.equal(resolutionOf({ ...open, resolvedBy: '0xabc' }), null);
  });

  it('does not settle on closed alone — trading halts before the ruling', () => {
    assert.equal(resolutionOf({ ...open, closed: true }), null);
  });

  it('does not settle on collapsed prices alone without the ruling', () => {
    // Trading can halt with the last prints at 0 and 1 before the oracle has
    // ruled. The prices look final; only the status says they are.
    const halted = { ...open, closed: true, outcomePrices: '["0", "1"]' };
    assert.equal(resolutionOf(halted), null);
  });

  it('does not settle on the status alone while prices are still fractional', () => {
    // Settling here would pay a probability instead of a payout.
    assert.equal(resolutionOf({ ...open, umaResolutionStatus: 'resolved' }), null);
  });

  it('handles a multi-outcome market with a single winner', () => {
    const multi = { ...resolved, outcomes: '["A","B","C"]', outcomePrices: '["0","0","1"]' };
    assert.deepEqual(resolutionOf(multi), { payouts: [0, 0, 1] });
  });

  it('refuses a ruling with no winner', () => {
    assert.equal(resolutionOf({ ...resolved, outcomePrices: '["0","0"]' }), null);
  });

  it('refuses a ruling with unparseable prices', () => {
    assert.equal(resolutionOf({ ...resolved, outcomePrices: 'nope' }), null);
    assert.equal(resolutionOf({ ...resolved, outcomePrices: '["x","1"]' }), null);
  });

  it('survives a missing market', () => {
    assert.equal(resolutionOf(null), null);
    assert.equal(resolutionOf(undefined), null);
  });
});

describe('SEGMENTS — the top-level split', () => {
  it('has unique keys and slugs', () => {
    assert.equal(new Set(SEGMENTS.map((s) => s.key)).size, SEGMENTS.length);
    assert.equal(new Set(SEGMENTS.map((s) => s.slug)).size, SEGMENTS.length);
  });

  it('puts ECONOMY ahead of POLITICS, because the Fed carries both tags', () => {
    const keys = SEGMENTS.map((s) => s.key);
    assert.ok(keys.indexOf('ECONOMY') < keys.indexOf('POLITICS'));
  });
});

describe('toRows — segment assignment', () => {
  const market = {
    id: 1, question: 'Will the Fed cut rates?', slug: 'fed',
    outcomes: '["Yes","No"]', clobTokenIds: '["a","b"]', outcomePrices: '["0.5","0.5"]',
  };

  it('uses the segment it was fetched under', () => {
    assert.equal(toRows(market, 'SPORTS')[0].category, 'SPORTS', 'real tags beat the regex');
  });

  it('falls back to reading the question when there is no segment', () => {
    assert.equal(toRows(market)[0].category, 'ECONOMY');
  });

  it('ignores a segment that is not a real one', () => {
    // A caller passing junk must not invent a category the filter cannot show.
    assert.equal(toRows(market, 'NONSENSE')[0].category, 'ECONOMY');
  });
});

describe('fetchUniverse — sharing the board between segments', () => {
  // Sizes mirror the live imbalance that broke this: politics and sports each
  // offer thousands of outcomes, weather a few hundred.
  const huge = (prefix, n) => Array.from({ length: n }, (_, i) => ({
    id: `${prefix}-${i}`, clobTokenIds: '["a","b"]',
  }));

  /** Stands in for the network: each segment answers with its own supply. */
  function fakeFetch(supply) {
    const segments = Object.keys(supply).map((slug) => ({ key: slug.toUpperCase(), slug }));
    const original = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const slug = new URL(url).searchParams.get('tag_slug');
      return { ok: true, json: async () => [{ markets: supply[slug] ?? [] }] };
    };
    return { segments, restore: () => { globalThis.fetch = original; } };
  }

  const bySegment = (universe) => universe.reduce((acc, u) => {
    acc[u.segment] = (acc[u.segment] || 0) + 1;
    return acc;
  }, {});

  it('gives every segment a share instead of spending in priority order', async () => {
    // The regression: greedy filling let the first two segments take all 1500
    // outcomes and the remaining seven came back empty.
    const { segments, restore } = fakeFetch({
      politics: huge('p', 400), sports: huge('s', 400), weather: huge('w', 400),
    });
    try {
      const universe = await fetchUniverse({ maxOutcomes: 60, segments });
      const counts = bySegment(universe);
      assert.deepEqual(Object.keys(counts).sort(), ['POLITICS', 'SPORTS', 'WEATHER']);
      assert.deepEqual(Object.values(counts), [10, 10, 10], 'an even split, not first-come-first-served');
    } finally { restore(); }
  });

  it('never exceeds the outcome budget', async () => {
    const { segments, restore } = fakeFetch({ politics: huge('p', 500), sports: huge('s', 500) });
    try {
      const universe = await fetchUniverse({ maxOutcomes: 25, segments });
      const outcomes = universe.reduce((n, u) => n + parseArr(u.market.clobTokenIds).length, 0);
      assert.ok(outcomes <= 25, `${outcomes} outcomes exceeds the budget of 25`);
    } finally { restore(); }
  });

  it('redistributes what a small segment cannot use', async () => {
    const { segments, restore } = fakeFetch({
      politics: huge('p', 100), sports: huge('s', 100), weather: huge('w', 2),
    });
    try {
      const universe = await fetchUniverse({ maxOutcomes: 60, segments });
      const counts = bySegment(universe);
      assert.equal(counts.WEATHER, 2, 'takes all it has');
      assert.equal(counts.POLITICS + counts.SPORTS, 28, 'the unused share goes to the others');
    } finally { restore(); }
  });

  it('claims a market for one segment only', async () => {
    const shared = [{ id: 'dupe', clobTokenIds: '["a","b"]' }];
    const { segments, restore } = fakeFetch({ economy: shared, politics: shared });
    try {
      const universe = await fetchUniverse({ maxOutcomes: 100, segments });
      assert.equal(universe.length, 1, 'the Fed is tagged both; it appears once');
      assert.equal(universe[0].segment, 'ECONOMY', 'the earlier segment claims it');
    } finally { restore(); }
  });

  it('carries on when a segment fails', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (new URL(url).searchParams.get('tag_slug') === 'sports') throw new Error('upstream down');
      return { ok: true, json: async () => [{ markets: huge('p', 10) }] };
    };
    try {
      const universe = await fetchUniverse({
        maxOutcomes: 40,
        segments: [{ key: 'SPORTS', slug: 'sports' }, { key: 'POLITICS', slug: 'politics' }],
      });
      assert.ok(universe.length > 0, 'politics still loads');
      assert.deepEqual(Object.keys(bySegment(universe)), ['POLITICS']);
    } finally { globalThis.fetch = original; }
  });

  it('skips a market with no tradeable tokens', async () => {
    const { segments, restore } = fakeFetch({
      politics: [{ id: 'empty', clobTokenIds: '[]' }, { id: 'real', clobTokenIds: '["a","b"]' }],
    });
    try {
      const universe = await fetchUniverse({ maxOutcomes: 10, segments });
      assert.deepEqual(universe.map((u) => u.market.id), ['real']);
    } finally { restore(); }
  });
});

describe('quoteState — why there is no price', () => {
  const book = (bids, asks) => ({ resolved: false, book: { bids, asks } });
  const L = [[0.5, 100]];

  it('is two-sided when both sides have resting size', () => {
    assert.equal(quoteState(book(L, L)), 'two-sided');
  });

  it('distinguishes a one-sided book from a missing one', () => {
    // The case that mattered: 80 asks and nobody bidding is not "no book".
    assert.equal(quoteState(book([], L)), 'ask-only');
    assert.equal(quoteState(book(L, [])), 'bid-only');
    assert.equal(quoteState(book([], [])), 'empty');
    assert.equal(quoteState({ resolved: false, book: null }), 'none');
  });

  it('reports a resolved market as gone whatever the book says', () => {
    assert.equal(quoteState({ resolved: true, book: null }), 'gone');
    assert.equal(quoteState({ resolved: true, book: { bids: L, asks: L } }), 'gone');
  });
});

describe('isStale — the book outranks the last trade', () => {
  const at = (last, bid, ask) => isStale({ last, bid, ask });

  it('is false for a last price inside the spread', () => {
    assert.equal(at(0.50, 0.49, 0.51), false);
  });

  it('is true for a last price below the bid', () => {
    assert.equal(at(0.40, 0.49, 0.51), true);
  });

  it('is true for a last price above the ask', () => {
    assert.equal(at(0.60, 0.49, 0.51), true);
  });

  it('tolerates float noise at the touch', () => {
    assert.equal(at(0.4895, 0.49, 0.51), false, 'half a tick of noise is not drift');
    assert.equal(at(0.4880, 0.49, 0.51), true, 'but real drift still flags');
  });

  it('cannot judge staleness without a two-sided book', () => {
    assert.equal(at(0.50, null, 0.51), false);
    assert.equal(at(0.50, 0.49, null), false);
    assert.equal(at(null, 0.49, 0.51), false);
  });
});
