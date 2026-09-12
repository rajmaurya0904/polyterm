import { useState } from 'react';
import { Panel } from '../components/Panel';
import { AccountSummary } from '../components/PaperPanel';
import { px, qty, usd } from '../format';
import { unmarkableReason, type Account, type Position } from '../types';

interface Props {
  positions: Position[];
  account: Account;
  onSelect: (tokenId: string) => void;
  onChanged: () => void;
}

/**
 * Positions with mark-to-market and a one-click close.
 *
 * Closing sells the whole position at market, filled against the live book —
 * so a thin book gives a worse average than the top-of-book mark suggests.
 */
export function PositionsView({ positions, account, onSelect, onChanged }: Props) {
  const [closing, setClosing] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const close = async (position: Position) => {
    setClosing(position.tokenId);
    setMessage(null);
    try {
      const res = await fetch('/api/paper/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tokenId: position.tokenId, side: 'sell', shares: position.shares }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Could not close');
      setMessage({
        kind: 'ok',
        text: `Closed ${qty(data.trade.filled)} @ ${px(data.trade.avg)} · realized ${usd(data.trade.realized)}`,
      });
      onChanged();
    } catch (err) {
      setMessage({ kind: 'error', text: (err as Error).message });
    } finally {
      setClosing(null);
    }
  };

  const reset = async () => {
    if (!confirm('Reset the paper account? This deletes all trades.')) return;
    await fetch('/api/paper/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    setMessage({ kind: 'ok', text: 'Account reset' });
    onChanged();
  };

  const [checking, setChecking] = useState(false);
  const checkSettlements = async () => {
    setChecking(true);
    setMessage(null);
    try {
      const res = await fetch('/api/paper/settle', { method: 'POST' });
      const data = await res.json();
      setMessage({
        kind: 'ok',
        text: data.settled
          ? `Settled ${data.settled} position${data.settled > 1 ? 's' : ''}`
          : 'Nothing has resolved yet',
      });
      if (data.settled) onChanged();
    } catch (err) {
      setMessage({ kind: 'error', text: (err as Error).message });
    } finally {
      setChecking(false);
    }
  };

  const known = positions.filter((p) => p.unrealized != null);
  const total = known.reduce((sum, p) => sum + (p.unrealized ?? 0), 0);
  const awaiting = positions.filter((p) => unmarkableReason(p) === 'awaiting ruling');
  const noBid = positions.filter((p) => unmarkableReason(p) === 'no bid');
  const noBook = positions.filter((p) => unmarkableReason(p) === 'no book');

  return (
    <div className="stack">
      <div className="stat-row">
        <Stat label="Cash" value={usd(account.balance)} />
        <Stat label="Deployed" value={usd(account.deployed)} />
        <Stat label="Realized" value={usd(account.realized)} tone={account.realized >= 0 ? 'up' : 'down'} />
        <Stat
          label="Unrealized"
          value={known.length ? usd(total) : '—'}
          tone={known.length ? (total >= 0 ? 'up' : 'down') : undefined}
        />
        <Stat label="Equity" value={usd(account.equity)} />
      </div>

      {message && <div className={`notice ${message.kind}`}>{message.text}</div>}

      <Panel
        title={`Open positions · ${positions.length}`}
        flush
        actions={
          <div className="form-row">
            {(awaiting.length > 0 || noBid.length > 0) && (
              <button className="btn" disabled={checking} onClick={checkSettlements}>
                {checking ? 'Checking…' : 'Check settlements'}
              </button>
            )}
            <button className="btn" onClick={reset}>Reset account</button>
          </div>
        }
      >
        {!positions.length ? (
          <div className="empty">No open positions — buy something from the Board</div>
        ) : (
          <div className="scroll-x">
            <table>
              <thead>
                <tr>
                  <th>Market</th>
                  <th>Outcome</th>
                  <th>Shares</th>
                  <th>Avg cost</th>
                  <th>Mark</th>
                  <th>Cost basis</th>
                  <th>Unrealized</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {positions.map((p) => (
                  <tr key={p.tokenId} className="clickable" onClick={() => onSelect(p.tokenId)}>
                    <td className="truncate wide" title={p.question}>{p.question}</td>
                    <td className="dim">{p.outcome}</td>
                    <td className="num">{qty(p.shares)}</td>
                    <td className="num dim">{px(p.avgCost)}</td>
                    <td className="num">
                      {p.mark != null ? px(p.mark) : <span className="faint">{unmarkableReason(p)}</span>}
                    </td>
                    <td className="num dim">{usd(p.cost)}</td>
                    <td className={`num ${p.unrealized == null ? 'faint' : p.unrealized >= 0 ? 'up' : 'down'}`}>
                      {p.unrealized == null ? '—' : usd(p.unrealized)}
                    </td>
                    <td>
                      <button
                        className="btn"
                        disabled={closing === p.tokenId || p.mark == null}
                        onClick={(e) => { e.stopPropagation(); void close(p); }}
                        title={closeHint(p)}
                      >
                        {closing === p.tokenId ? 'Closing…' : 'Close'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {awaiting.length > 0 && (
        <div className="notice ok">
          {plural(awaiting.length, 'position is', 'positions are')} in a closed market. Once the oracle rules,
          each share pays $1.00 on the winning outcome or $0.00 otherwise and the position settles automatically
          — checked every minute, or now with the button above.
        </div>
      )}
      {noBid.length > 0 && (
        <div className="notice ok">
          {plural(noBid.length, 'position has', 'positions have')} a live book with offers but no bids, so there is
          nothing to sell into and no exit price to mark against. That is the market pricing the outcome at
          effectively nothing, not missing data — it is left out of the unrealized total rather than counted as a
          loss it has not taken. It settles at $1.00 or $0.00 when the market resolves.
        </div>
      )}
      {noBook.length > 0 && (
        <div className="notice error">
          {plural(noBook.length, 'position has', 'positions have')} no order book at all — the last fetch returned
          nothing. Excluded from the unrealized total rather than counted as flat.
        </div>
      )}

      <Panel title="Account">
        <AccountSummary account={account} />
      </Panel>
    </div>
  );
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function closeHint(p: Position): string {
  switch (unmarkableReason(p)) {
    case 'awaiting ruling': return 'Market closed — settles at $1.00 or $0.00 once the oracle rules';
    case 'no bid': return 'Nobody is bidding on this outcome, so there is nothing to sell into';
    case 'no book': return 'No live book to sell into';
    default: return 'Sell the whole position at market';
  }
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'up' | 'down' }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className={`stat-value ${tone ?? ''}`}>{value}</div>
    </div>
  );
}
