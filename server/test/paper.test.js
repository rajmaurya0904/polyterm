/**
 * Paper-trading engine tests.
 *
 * The fill walker and position accounting are the only place in this project
 * where a number is produced rather than relayed, so they are the only place a
 * bug can be silent. Everything here runs against fabricated books — no
 * network, no live feed.
 */

import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { createPaperStore, derivePositions, simulate } from '../src/paper.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'polyterm-test-'));
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

let n = 0;
/** A store backed by a fresh file, so tests cannot bleed into each other. */
function store() {
  return createPaperStore(path.join(tmpRoot, `paper-${n++}.json`));
}

/** A row shaped the way the relay builds one, with a book we control. */
function row(book, tokenId = 'tok-1') {
  return {
    tokenId,
    marketId: 'mkt-1',
    outcomeIndex: 0,
    question: 'Will it rain?',
    outcome: 'Yes',
    book,
  };
}

const BOOK = {
  // [price, size], best first
  asks: [[0.50, 100], [0.52, 200], [0.55, 500]],
  bids: [[0.48, 100], [0.46, 200], [0.40, 500]],
};

describe('simulate — walking the book', () => {
  it('fills inside the top level at that level price', () => {
    const r = simulate(BOOK.asks, 50, null, 'buy');
    assert.equal(r.filled, 50);
    assert.equal(r.unfilled, 0);
    assert.equal(r.avg, 0.50);
    assert.deepEqual(r.fills, [{ price: 0.50, size: 50 }]);
  });

  it('walks into deeper levels and averages up', () => {
    const r = simulate(BOOK.asks, 250, null, 'buy');
    assert.equal(r.filled, 250);
    assert.equal(r.fills.length, 2);
    // 100 @ 0.50 + 150 @ 0.52 = 128 / 250
    assert.equal(r.cost.toFixed(4), '128.0000');
    assert.equal(r.avg.toFixed(4), '0.5120');
    assert.ok(r.avg > BOOK.asks[0][0], 'average must be worse than the touch');
  });

  it('reports a partial fill rather than inventing liquidity', () => {
    const thin = { asks: [[0.50, 10]] };
    const r = simulate(thin.asks, 1000, null, 'buy');
    assert.equal(r.filled, 10);
    assert.equal(r.unfilled, 990);
    assert.equal(r.cost.toFixed(2), '5.00');
  });

  it('stops a buy at the limit instead of crossing it', () => {
    const r = simulate(BOOK.asks, 1000, 0.52, 'buy');
    assert.equal(r.filled, 300, 'takes 0.50 and 0.52, stops before 0.55');
    assert.equal(r.unfilled, 700);
  });

  it('stops a sell at the limit instead of crossing it', () => {
    const r = simulate(BOOK.bids, 1000, 0.46, 'sell');
    assert.equal(r.filled, 300, 'hits 0.48 and 0.46, stops before 0.40');
  });

  it('fills nothing when the limit is not marketable', () => {
    const r = simulate(BOOK.asks, 100, 0.10, 'buy');
    assert.equal(r.filled, 0);
    assert.equal(r.avg, 0, 'no divide-by-zero on an unfilled order');
    assert.deepEqual(r.fills, []);
  });

  it('fills nothing against an empty book', () => {
    assert.equal(simulate([], 100, null, 'buy').filled, 0);
  });
});

describe('derivePositions — accounting from the trade log', () => {
  const buy = (filled, avg, tokenId = 'tok-1') => ({
    tokenId, marketId: 'm', outcomeIndex: 0, question: 'q', outcome: 'Yes',
    side: 'buy', filled, avg,
  });
  const sell = (filled, avg, tokenId = 'tok-1') => ({ ...buy(filled, avg, tokenId), side: 'sell' });

  it('is empty with no trades', () => {
    assert.deepEqual(derivePositions([]), []);
  });

  it('weights the average cost across several buys', () => {
    const [p] = derivePositions([buy(100, 0.40), buy(100, 0.60)]);
    assert.equal(p.shares, 200);
    assert.equal(p.avgCost.toFixed(4), '0.5000');
  });

  it('reduces the basis at the running average, not the sale price', () => {
    // Buy 200 @ 0.50, sell 100 @ 0.90. The remaining 100 still cost 0.50.
    const [p] = derivePositions([buy(200, 0.50), sell(100, 0.90)]);
    assert.equal(p.shares, 100);
    assert.equal(p.avgCost.toFixed(4), '0.5000', 'profit does not distort the basis');
    assert.equal(p.cost.toFixed(4), '50.0000');
  });

  it('drops a fully closed position', () => {
    assert.deepEqual(derivePositions([buy(100, 0.50), sell(100, 0.60)]), []);
  });

  it('keeps tokens separate', () => {
    const out = derivePositions([buy(10, 0.5, 'a'), buy(20, 0.5, 'b')]);
    assert.equal(out.length, 2);
    assert.deepEqual(out.map((p) => p.shares).sort((x, y) => x - y), [10, 20]);
  });

  it('treats a float-dust residue as closed', () => {
    // 0.1 + 0.2 - 0.3 leaves 5.55e-17, not 0. An exact !== 0 check would keep
    // a ghost position on the books forever.
    const residue = 0.1 + 0.2 - 0.3;
    assert.notEqual(residue, 0, 'guard the premise: this really is non-zero');

    const out = derivePositions([buy(0.1, 0.5), buy(0.2, 0.5), sell(0.3, 0.5)]);
    assert.deepEqual(out, [], 'dust must not survive as a position');
  });
});

describe('place — order guards', () => {
  const reject = (result, needle) => {
    assert.equal(result.ok, false);
    assert.match(result.reason, needle);
  };

  it('rejects an unknown market', () => {
    reject(store().place({ row: undefined, side: 'buy', shares: 1 }), /unknown market/);
  });

  it('rejects non-positive and non-finite share counts', () => {
    const s = store();
    for (const shares of [0, -5, NaN, Infinity]) {
      reject(s.place({ row: row(BOOK), side: 'buy', shares }), /shares must be positive/);
    }
  });

  it('rejects a limit outside (0, 1)', () => {
    const s = store();
    for (const limit of [0, 1, 1.5, -0.2, NaN]) {
      reject(s.place({ row: row(BOOK), side: 'buy', shares: 1, limit }), /limit must be between/);
    }
  });

  it('rejects an outcome with no live book', () => {
    reject(store().place({ row: row(null), side: 'buy', shares: 1 }), /no live book/);
  });

  it('rejects a side with no resting liquidity', () => {
    const s = store();
    reject(s.place({ row: row({ asks: [], bids: BOOK.bids }), side: 'buy', shares: 1 }), /no resting asks/);
    reject(s.place({ row: row({ asks: BOOK.asks, bids: [] }), side: 'sell', shares: 1 }), /no resting bids/);
  });

  it('rejects a sell of shares that are not held', () => {
    reject(store().place({ row: row(BOOK), side: 'sell', shares: 10 }), /you hold 0 shares/);
  });

  it('rejects a sell larger than the position', () => {
    const s = store();
    s.place({ row: row(BOOK), side: 'buy', shares: 50 });
    reject(s.place({ row: row(BOOK), side: 'sell', shares: 80 }), /you hold 50 shares/);
  });

  it('rejects an order that costs more than the balance', () => {
    const s = store();
    s.reset(10);
    reject(s.place({ row: row(BOOK), side: 'buy', shares: 100 }), /balance 10\.00/);
  });

  it('rejects an unmarketable limit with the touch in the message', () => {
    reject(
      store().place({ row: row(BOOK), side: 'buy', shares: 10, limit: 0.1 }),
      /no fill at limit \(best ask 0\.5\)/,
    );
  });
});

describe('place — accepted orders', () => {
  it('debits the balance and opens a position', () => {
    const s = store();
    const before = s.state.balance;
    const res = s.place({ row: row(BOOK), side: 'buy', shares: 100 });

    assert.equal(res.ok, true);
    assert.equal(res.trade.filled, 100);
    assert.equal(res.trade.cost.toFixed(2), '50.00');
    assert.equal((before - s.state.balance).toFixed(2), '50.00');

    const [p] = s.positions();
    assert.equal(p.shares, 100);
    assert.equal(p.avgCost.toFixed(4), '0.5000');
  });

  it('books realized P/L on a sell and credits the proceeds', () => {
    const s = store();
    s.place({ row: row(BOOK), side: 'buy', shares: 100 });      // 100 @ 0.50 = 50.00
    const res = s.place({ row: row(BOOK), side: 'sell', shares: 100 }); // 100 @ 0.48 = 48.00

    assert.equal(res.ok, true);
    // Sold into the bid, so the spread is the loss: (0.48 - 0.50) * 100.
    assert.equal(res.trade.realized.toFixed(2), '-2.00');
    assert.equal(s.state.realized.toFixed(2), '-2.00');
    assert.equal(s.state.balance.toFixed(2), '9998.00');
    assert.deepEqual(s.positions(), [], 'position is flat again');
  });

  it('records every level it walked', () => {
    const s = store();
    const { trade } = s.place({ row: row(BOOK), side: 'buy', shares: 250 });
    assert.equal(trade.fills.length, 2);
    assert.deepEqual(trade.fills, [{ price: 0.50, size: 100 }, { price: 0.52, size: 150 }]);
  });

  it('keeps the requested size alongside a partial fill', () => {
    const s = store();
    const { trade } = s.place({ row: row({ asks: [[0.5, 10]], bids: [] }), side: 'buy', shares: 100 });
    assert.equal(trade.shares, 100);
    assert.equal(trade.filled, 10);
    assert.equal(trade.unfilled, 90);
  });

  it('mints unique ids for orders placed in the same millisecond', (t) => {
    // Freeze the clock, because a wall-clock test would pass by accident as
    // soon as a disk write pushed two orders into different milliseconds —
    // which is exactly the case a naive Date.now() id survives.
    t.mock.method(Date, 'now', () => 1_700_000_000_000);

    const s = store();
    const ids = [];
    for (let i = 0; i < 25; i += 1) {
      ids.push(s.place({ row: row(BOOK), side: 'buy', shares: 1 }).trade.id);
    }

    assert.equal(new Set(ids).size, 25, 'trade ids are React keys — collisions corrupt the UI');
    assert.deepEqual(ids, [...ids].sort((a, b) => a - b), 'ids increase monotonically');
  });

  it('reports equity as cash plus the cost of what is deployed', () => {
    const s = store();
    s.place({ row: row(BOOK), side: 'buy', shares: 100 });
    const { balance, deployed, equity } = s.state;
    assert.equal(deployed.toFixed(2), '50.00');
    assert.equal(equity.toFixed(2), (balance + deployed).toFixed(2));
    assert.equal(equity.toFixed(2), '10000.00', 'a fill at cost does not change equity');
  });
});

describe('persistence', () => {
  it('survives a reload from disk', () => {
    const file = path.join(tmpRoot, 'reload.json');
    const first = createPaperStore(file);
    first.place({ row: row(BOOK), side: 'buy', shares: 100 });

    const second = createPaperStore(file);
    assert.equal(second.state.balance.toFixed(2), '9950.00');
    assert.equal(second.positions()[0].shares, 100);
  });

  it('does not reuse an id after a reload', () => {
    const file = path.join(tmpRoot, 'ids.json');
    const first = createPaperStore(file);
    const a = first.place({ row: row(BOOK), side: 'buy', shares: 1 }).trade.id;
    const b = createPaperStore(file).place({ row: row(BOOK), side: 'buy', shares: 1 }).trade.id;
    assert.notEqual(a, b);
  });

  it('falls back to a fresh account when the file is corrupt', () => {
    const file = path.join(tmpRoot, 'corrupt.json');
    fs.writeFileSync(file, '{ this is not json');
    assert.equal(createPaperStore(file).state.balance, 10_000);
  });

  it('falls back when the file is valid JSON of the wrong shape', () => {
    const file = path.join(tmpRoot, 'wrong-shape.json');
    fs.writeFileSync(file, JSON.stringify({ balance: 'lots', trades: 'many' }));
    assert.equal(createPaperStore(file).state.balance, 10_000);
  });

  it('leaves no temp file behind after writing', () => {
    const file = path.join(tmpRoot, 'atomic.json');
    createPaperStore(file).place({ row: row(BOOK), side: 'buy', shares: 1 });
    const strays = fs.readdirSync(tmpRoot).filter((f) => f.startsWith('atomic.json.'));
    assert.deepEqual(strays, []);
  });

  it('reset clears trades and sets both balances', () => {
    const s = store();
    s.place({ row: row(BOOK), side: 'buy', shares: 100 });
    s.reset(500);
    assert.equal(s.state.balance, 500);
    assert.equal(s.state.startingBalance, 500);
    assert.equal(s.state.realized, 0);
    assert.deepEqual(s.positions(), []);
    assert.deepEqual(s.trades(), []);
  });
});

describe('trades()', () => {
  it('returns newest first and honours the limit', () => {
    const s = store();
    for (let i = 0; i < 5; i += 1) s.place({ row: row(BOOK), side: 'buy', shares: 1 });
    const recent = s.trades(3);
    assert.equal(recent.length, 3);
    assert.ok(recent[0].id > recent[2].id, 'newest first');
  });
});
