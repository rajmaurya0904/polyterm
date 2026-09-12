import { useState } from 'react';
import { Panel } from '../components/Panel';
import { px, qty, usd } from '../format';
import type { Trade } from '../types';

/**
 * Paper trade log. Each row expands to the individual fills, which is where
 * slippage becomes visible — a single order often consumes several price
 * levels, and the average tells you less than the ladder it walked.
 */
export function HistoryView({ trades, loading }: { trades: Trade[]; loading: boolean }) {
  const [expanded, setExpanded] = useState<number | null>(null);

  if (loading) return <div className="empty">Loading…</div>;

  if (!trades.length) {
    return (
      <Panel title="Trade history">
        <div className="empty">No paper trades yet</div>
      </Panel>
    );
  }

  const realized = trades.reduce((sum, t) => sum + (t.realized || 0), 0);
  const volume = trades.reduce((sum, t) => sum + t.cost, 0);
  const buys = trades.filter((t) => t.side === 'buy').length;
  const settled = trades.filter((t) => t.settlement).length;
  const sells = trades.length - buys - settled;

  return (
    <div className="stack">
      <div className="stat-row">
        <Stat label="Trades" value={String(trades.length)} />
        <Stat label="Buys / Sells" value={`${buys} / ${sells}`} />
        <Stat label="Settled" value={String(settled)} />
        <Stat label="Turnover" value={usd(volume)} />
        <Stat label="Realized" value={usd(realized)} tone={realized >= 0 ? 'up' : 'down'} />
      </div>

      <Panel title="Trade history" flush>
        <div className="scroll-x">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Side</th>
                <th>Market</th>
                <th>Outcome</th>
                <th>Filled</th>
                <th>Avg</th>
                <th>Value</th>
                <th>Realized</th>
                <th>Levels</th>
              </tr>
            </thead>
            <tbody>
              {trades.map((trade) => (
                <TradeRow
                  key={trade.id}
                  trade={trade}
                  open={expanded === trade.id}
                  onToggle={() => setExpanded(expanded === trade.id ? null : trade.id)}
                />
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}

function TradeRow({ trade, open, onToggle }: { trade: Trade; open: boolean; onToggle: () => void }) {
  const when = new Date(trade.at);
  return (
    <>
      <tr className="clickable" onClick={onToggle}>
        <td className="dim">{when.toLocaleString()}</td>
        <td>
          {trade.settlement
            ? <span className="badge mkt" title={`Paid out at $${trade.avg.toFixed(2)} per share by resolution`}>SETTLED</span>
            : <span className={trade.side === 'buy' ? 'badge bid' : 'badge ofr'}>{trade.side.toUpperCase()}</span>}
        </td>
        <td className="truncate wide" title={trade.question}>{trade.question}</td>
        <td className="dim">{trade.outcome}</td>
        <td className="num">
          {qty(trade.filled)}
          {trade.unfilled > 0 && <span className="faint"> (+{qty(trade.unfilled)} unfilled)</span>}
        </td>
        <td className="num">{px(trade.avg)}</td>
        <td className="num dim">{usd(trade.cost)}</td>
        <td className={`num ${trade.realized ? (trade.realized >= 0 ? 'up' : 'down') : 'faint'}`}>
          {trade.realized ? usd(trade.realized) : '—'}
        </td>
        <td className="num faint">{trade.fills.length} {open ? '▾' : '▸'}</td>
      </tr>
      {open && (
        <tr>
          <td colSpan={9} style={{ background: 'var(--panel-alt)' }}>
            <div className="fills">
              {trade.fills.map((fill, i) => (
                <div className="fill" key={i}>
                  <span className="num">{qty(fill.size)}</span>
                  <span className="dim"> @ </span>
                  <span className="num">{px(fill.price)}</span>
                </div>
              ))}
              {trade.fills.length > 1 && (
                <div className="faint" style={{ marginLeft: 'auto', fontSize: 11 }}>
                  walked {trade.fills.length} levels · {px(trade.fills[0].price)} → {px(trade.fills[trade.fills.length - 1].price)}
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'up' | 'down' }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className={`stat-value ${tone ?? ''}`}>{value}</div>
    </div>
  );
}
