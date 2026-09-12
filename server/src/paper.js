/**
 * Paper trading — simulated fills against the live order book.
 *
 * No real money, no wallet, no exchange call. An order is filled locally by
 * walking the book that was fetched for display, and the result is written to
 * a JSON file. Deleting that file resets everything.
 */

import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_BALANCE = 10_000;

/**
 * Walk the book to fill `shares`, the way a marketable order would: consume
 * each level in turn until filled or the limit price is crossed. Returns a
 * partial fill when the book runs dry — never invents liquidity.
 *
 * Pure, so the fill maths can be tested without a store or a live feed.
 */
export function simulate(levels, shares, limit, side) {
  let remaining = shares;
  let cost = 0;
  const fills = [];
  for (const [price, size] of levels) {
    if (remaining <= 0) break;
    if (limit != null) {
      if (side === 'buy' && price > limit) break;
      if (side === 'sell' && price < limit) break;
    }
    const take = Math.min(remaining, size);
    if (take <= 0) continue;
    cost += take * price;
    remaining -= take;
    fills.push({ price, size: take });
  }
  const filled = shares - remaining;
  return { filled, cost, avg: filled > 0 ? cost / filled : 0, fills, unfilled: remaining };
}

/**
 * Net position per token, derived from the trade log rather than stored
 * alongside it — the log is the single source of truth, so the two can never
 * disagree. Sells reduce cost at the running average, which is what leaves
 * realized P/L out of the remaining basis.
 */
export function derivePositions(trades) {
  const acc = new Map();
  for (const t of trades) {
    const cur = acc.get(t.tokenId) || {
      tokenId: t.tokenId, marketId: t.marketId, outcomeIndex: t.outcomeIndex,
      question: t.question, outcome: t.outcome, shares: 0, cost: 0,
    };
    if (t.side === 'buy') {
      cur.shares += t.filled;
      cur.cost += t.filled * t.avg;
    } else {
      const avgCost = cur.shares > 0 ? cur.cost / cur.shares : 0;
      cur.shares -= t.filled;
      cur.cost -= t.filled * avgCost;
    }
    acc.set(t.tokenId, cur);
  }
  return [...acc.values()]
    .filter((p) => Math.abs(p.shares) > 1e-9)
    .map((p) => ({ ...p, avgCost: p.cost / p.shares }));
}

export function createPaperStore(filePath) {
  const dir = path.dirname(filePath);

  function load() {
    try {
      if (fs.existsSync(filePath)) {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (parsed && Number.isFinite(parsed.balance) && Array.isArray(parsed.trades)) return parsed;
      }
    } catch {
      // Corrupt or unreadable — fall through to a fresh account rather than crash.
    }
    return { balance: DEFAULT_BALANCE, startingBalance: DEFAULT_BALANCE, trades: [] };
  }

  let state = load();

  /** Write-then-rename so a crash mid-write never leaves a truncated file. */
  function persist() {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, filePath);
  }

  // Trade ids double as React keys and expand handles in the UI, so they must
  // stay unique even when two orders land in the same millisecond.
  let lastId = state.trades.reduce((m, t) => Math.max(m, t.id || 0), 0);
  function nextId() {
    lastId = Math.max(lastId + 1, Date.now());
    return lastId;
  }

  // Reads `state` at call time, so it follows a reset.
  const positions = () => derivePositions(state.trades);

  return {
    get state() {
      const realized = state.trades.reduce((sum, t) => sum + (t.realized || 0), 0);
      const deployed = positions().reduce((sum, p) => sum + p.cost, 0);
      return {
        balance: state.balance,
        startingBalance: state.startingBalance,
        realized,
        deployed,
        equity: state.balance + deployed,
      };
    },

    positions,

    trades(limit = 50) {
      return state.trades.slice(-limit).reverse();
    },

    /**
     * @param {object} order  {row, side, shares, limit}
     * @returns {{ok: boolean, reason?: string, trade?: object}}
     */
    place({ row, side, shares, limit }) {
      if (!row) return { ok: false, reason: 'unknown market' };
      if (!Number.isFinite(shares) || shares <= 0) return { ok: false, reason: 'shares must be positive' };
      if (limit != null && (!Number.isFinite(limit) || limit <= 0 || limit >= 1)) {
        return { ok: false, reason: 'limit must be between 0 and 1' };
      }
      if (!row.book) return { ok: false, reason: 'no live book for this outcome' };

      const levels = side === 'buy' ? row.book.asks : row.book.bids;
      if (!levels || !levels.length) {
        return { ok: false, reason: `no resting ${side === 'buy' ? 'asks' : 'bids'}` };
      }

      const held = positions().find((p) => p.tokenId === row.tokenId);
      if (side === 'sell' && (!held || held.shares < shares)) {
        return { ok: false, reason: `you hold ${held ? held.shares : 0} shares` };
      }

      const sim = simulate(levels, shares, limit, side);
      if (sim.filled <= 0) {
        return { ok: false, reason: `no fill at limit (best ${side === 'buy' ? 'ask' : 'bid'} ${levels[0][0]})` };
      }
      if (side === 'buy' && sim.cost > state.balance) {
        return { ok: false, reason: `costs ${sim.cost.toFixed(2)}, balance ${state.balance.toFixed(2)}` };
      }

      let realized = 0;
      if (side === 'sell') {
        const avgCost = held && held.shares > 0 ? held.cost / held.shares : 0;
        realized = (sim.avg - avgCost) * sim.filled;
      }

      state.balance += side === 'buy' ? -sim.cost : sim.cost;

      const trade = {
        id: nextId(),
        at: new Date().toISOString(),
        tokenId: row.tokenId,
        marketId: row.marketId,
        outcomeIndex: row.outcomeIndex,
        question: row.question,
        outcome: row.outcome,
        side,
        shares,
        filled: sim.filled,
        unfilled: sim.unfilled,
        avg: sim.avg,
        cost: sim.cost,
        fills: sim.fills,
        realized,
      };
      state.trades.push(trade);
      persist();
      return { ok: true, trade };
    },

    /**
     * Settle a held position at its resolution payout — $1.00 per share on
     * the winning outcome, $0.00 on a loser. Recorded as a sell so position
     * netting needs no special case, flagged so the UI can tell it apart from
     * a trade the user chose to make.
     *
     * @param {string} tokenId
     * @param {0|1} payout
     */
    settle(tokenId, payout) {
      if (payout !== 0 && payout !== 1) return { ok: false, reason: 'payout must be 0 or 1' };
      const held = positions().find((p) => p.tokenId === tokenId);
      if (!held || held.shares <= 0) return { ok: false, reason: 'no position to settle' };

      const proceeds = payout * held.shares;
      state.balance += proceeds;

      const trade = {
        id: nextId(),
        at: new Date().toISOString(),
        tokenId: held.tokenId,
        marketId: held.marketId,
        outcomeIndex: held.outcomeIndex,
        question: held.question,
        outcome: held.outcome,
        side: 'sell',
        settlement: true,
        shares: held.shares,
        filled: held.shares,
        unfilled: 0,
        avg: payout,
        cost: proceeds,
        fills: [{ price: payout, size: held.shares }],
        realized: (payout - held.avgCost) * held.shares,
      };
      state.trades.push(trade);
      persist();
      return { ok: true, trade };
    },

    reset(startingBalance = DEFAULT_BALANCE) {
      state = { balance: startingBalance, startingBalance, trades: [] };
      persist();
    },
  };
}
