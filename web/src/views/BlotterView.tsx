import { useMemo, useState } from 'react';
import { Panel } from '../components/Panel';
import { compact, px, qty } from '../format';
import type { Row } from '../types';

type SortKey = 'spread' | 'volume' | 'size';

/**
 * Full-width quote blotter across every watched outcome.
 *
 * Sorting by spread surfaces where the cost of crossing is lowest; by resting
 * size, where you could actually get filled. Those rarely agree, which is the
 * point of showing both.
 */
export function BlotterView({ rows, onSelect }: { rows: Row[]; onSelect: (id: string) => void }) {
  const [sort, setSort] = useState<SortKey>('volume');
  const [hideWide, setHideWide] = useState(false);

  const lines = useMemo(() => {
    const out = rows
      .filter((row) => row.bid != null && row.ask != null && row.book)
      .map((row) => ({
        row,
        bidSize: row.book?.bids[0]?.[1] ?? 0,
        askSize: row.book?.asks[0]?.[1] ?? 0,
        spread: row.spread ?? 1,
      }))
      .filter((line) => !hideWide || line.spread <= 0.02);

    out.sort((a, b) => {
      if (sort === 'spread') return a.spread - b.spread;
      if (sort === 'size') return (b.bidSize + b.askSize) - (a.bidSize + a.askSize);
      return b.row.volume24h - a.row.volume24h;
    });
    return out;
  }, [rows, sort, hideWide]);

  return (
    <Panel
      title={`Blotter · ${lines.length} quotes`}
      flush
      actions={
        <div className="form-row">
          <label className="faint" style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11 }}>
            <input type="checkbox" checked={hideWide} onChange={(e) => setHideWide(e.target.checked)} />
            tight only (≤ 0.02)
          </label>
          <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} className="select">
            <option value="volume">Sort: 24h volume</option>
            <option value="spread">Sort: tightest spread</option>
            <option value="size">Sort: most resting size</option>
          </select>
        </div>
      }
    >
      {!lines.length ? (
        <div className="empty">No two-sided quotes right now</div>
      ) : (
        <div className="scroll-x">
          <table>
            <thead>
              <tr>
                <th>Market</th>
                <th>Outcome</th>
                <th>Bid size</th>
                <th>Bid</th>
                <th>Ask</th>
                <th>Ask size</th>
                <th>Spread</th>
                <th>Mid</th>
                <th>24h Vol</th>
              </tr>
            </thead>
            <tbody>
              {lines.map(({ row, bidSize, askSize, spread }) => (
                <tr key={row.tokenId} className="clickable" onClick={() => onSelect(row.tokenId)}>
                  <td className="truncate wide" title={row.question}>
                    {row.question}
                    {row.held && <span className="badge mkt" style={{ marginLeft: 6 }}>POS</span>}
                  </td>
                  <td className="dim">{row.outcome}</td>
                  <td className="num dim">{qty(bidSize)}</td>
                  <td className="num up">{px(row.bid)}</td>
                  <td className="num down">{px(row.ask)}</td>
                  <td className="num dim">{qty(askSize)}</td>
                  <td className={`num ${spread <= 0.01 ? 'up' : spread >= 0.05 ? 'down' : 'dim'}`}>
                    {spread.toFixed(3)}
                  </td>
                  <td className="num">{px(((row.bid ?? 0) + (row.ask ?? 0)) / 2)}</td>
                  <td className="num dim">{compact(row.volume24h)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
