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

export function createPaperStore(filePath) {
  const dir = path.dirname(filePath);

  function load() {
    try {
      if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      // Corrupt or unreadable — fall through to a fresh account rather than crash.
    }
    return { balance: DEFAULT_BALANCE, startingBalance: DEFAULT_BALANCE, trades: [] };
  }

  let state = load();

  function persist() {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
  }

  /**
   * Walk the book to fill `shares`, the way a marketable order would: consume
   * each level in turn until filled or the limit price is crossed. Returns a
   * partial fill when the book runs dry — never invents liquidity.
   */
  function simulate(levels, shares, limit, side) {
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

  /** Net position per token, derived from the trade log. */
  function positions() {
    const acc = new Map();
    for (const t of state.trades) {
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
        id: Date.now(),
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

    reset(startingBalance = DEFAULT_BALANCE) {
      state = { balance: startingBalance, startingBalance, trades: [] };
      persist();
    },
  };
}
