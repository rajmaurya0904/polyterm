import { useState } from 'react';
import { unmarkableReason, type Account, type Position, type Row } from '../types';
import { px, qty, usd } from '../format';

interface TicketProps {
  row: Row | null;
  onPlaced: () => void;
}

/**
 * Paper order ticket. Fills are simulated server-side against the live book —
 * no order ever leaves this machine.
 */
export function OrderTicket({ row, onPlaced }: TicketProps) {
  const [shares, setShares] = useState('100');
  const [limit, setLimit] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  if (!row) return <div className="empty">Select a market to trade</div>;

  const submit = async (side: 'buy' | 'sell') => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch('/api/paper/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tokenId: row.tokenId,
          side,
          shares: Number(shares),
          limit: limit === '' ? null : Number(limit),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMessage({ kind: 'error', text: data.error ?? 'Order rejected' });
      } else {
        const t = data.trade;
        setMessage({
          kind: 'ok',
          text: `${side.toUpperCase()} ${qty(t.filled)} @ ${px(t.avg)} · ${usd(t.cost)}` +
            (t.unfilled > 0 ? ` · ${qty(t.unfilled)} unfilled` : ''),
        });
        onPlaced();
      }
    } catch (err) {
      setMessage({ kind: 'error', text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'grid', gap: 9 }}>
      <div>
        <div className="truncate" title={row.question}>{row.question}</div>
        <div className="faint" style={{ fontSize: 11 }}>
          {row.outcome} · bid {px(row.bid)} · ask {px(row.ask)}
        </div>
      </div>

      <div className="form-row">
        <div className="field">
          <label>Shares</label>
          <input value={shares} onChange={(e) => setShares(e.target.value)} inputMode="decimal" />
        </div>
        <div className="field">
          <label>Limit</label>
          <input
            value={limit}
            onChange={(e) => setLimit(e.target.value)}
            placeholder="mkt"
            inputMode="decimal"
          />
        </div>
      </div>

      <div className="form-row">
        <button className="btn primary" disabled={busy} onClick={() => submit('buy')} style={{ flex: 1 }}>
          Buy
        </button>
        <button className="btn" disabled={busy} onClick={() => submit('sell')} style={{ flex: 1 }}>
          Sell
        </button>
      </div>

      {message && <div className={`notice ${message.kind}`}>{message.text}</div>}

      <div className="faint" style={{ fontSize: 11 }}>
        Simulated fill against the live book. No wallet, no real order.
      </div>
    </div>
  );
}

export function AccountSummary({ account }: { account: Account }) {
  return (
    <div>
      <div className="kv"><span className="k">Cash</span><span className="v">{usd(account.balance)}</span></div>
      <div className="kv"><span className="k">Deployed</span><span className="v">{usd(account.deployed)}</span></div>
      <div className="kv">
        <span className="k">Realized</span>
        <span className={`v ${account.realized >= 0 ? 'up' : 'down'}`}>{usd(account.realized)}</span>
      </div>
      <div className="kv"><span className="k">Equity</span><span className="v">{usd(account.equity)}</span></div>
    </div>
  );
}

export function Positions({ positions, onSelect }: { positions: Position[]; onSelect: (id: string) => void }) {
  if (!positions.length) return <div className="empty">No open positions</div>;

  // A position with no live book is unknown, never counted as flat.
  const total = positions.reduce((sum, p) => sum + (p.unrealized ?? 0), 0);
  const unmarked = positions.filter((p) => p.unrealized == null).length;

  return (
    <div className="scroll-x">
      <table>
        <thead>
          <tr>
            <th>Market</th>
            <th>Shares</th>
            <th>Avg</th>
            <th>Mark</th>
            <th>Unreal.</th>
          </tr>
        </thead>
        <tbody>
          {positions.map((p) => (
            <tr key={p.tokenId} className="clickable" onClick={() => onSelect(p.tokenId)}>
              <td className="truncate" title={p.question}>
                {p.question} <span className="dim">[{p.outcome}]</span>
              </td>
              <td className="num">{qty(p.shares)}</td>
              <td className="num dim">{px(p.avgCost)}</td>
              <td className="num">
                {p.mark != null ? px(p.mark) : <span className="faint">{unmarkableReason(p)}</span>}
              </td>
              <td className={`num ${p.unrealized == null ? 'faint' : p.unrealized >= 0 ? 'up' : 'down'}`}>
                {p.unrealized == null ? '—' : usd(p.unrealized)}
              </td>
            </tr>
          ))}
          <tr>
            <td colSpan={4} className="dim">Total unrealized</td>
            <td className={`num ${total >= 0 ? 'up' : 'down'}`}>
              {usd(total)}{unmarked ? <span className="faint"> ({unmarked} unmarked)</span> : null}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
