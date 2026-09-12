/**
 * Normalisation tests for the Polymarket adapter.
 *
 * These cover the pure half: turning the upstream payload into rows, bucketing
 * markets, and judging whether a last-trade price is still meaningful. The
 * fetch half needs the network and is exercised by running the server.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { categorise, isStale, parseArr, toRows } from '../src/polymarket.js';

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
    ['Will the Fed cut rates in March?', 'MACRO'],
    ['Will CPI come in above 3%?', 'MACRO'],
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
    // "rate" must not fire on "grateful", or half the board lands in MACRO.
    assert.equal(categorise({ question: 'Will anyone be grateful?' }), 'OTHER');
  });

  it('survives a market with no text at all', () => {
    assert.equal(categorise({}), 'OTHER');
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
