import type { Row } from '../types';
import { px, qty } from '../format';

/**
 * Top-of-book quotes as a trade blotter: one BID and one OFR line per
 * outcome, with the size resting at that price.
 */
export function Blotter({ rows, onSelect }: { rows: Row[]; onSelect: (id: string) => void }) {
  const lines = rows.flatMap((row) => {
    const out = [];
    if (row.bid != null && row.book?.bids.length) {
      out.push({ key: `${row.tokenId}-b`, row, type: 'BID' as const, price: row.bid, size: row.book.bids[0][1] });
    }
    if (row.ask != null && row.book?.asks.length) {
      out.push({ key: `${row.tokenId}-a`, row, type: 'OFR' as const, price: row.ask, size: row.book.asks[0][1] });
    }
    return out;
  });

  if (!lines.length) return <div className="empty">No live quotes</div>;

  return (
    <div className="scroll-x">
      <table>
        <thead>
          <tr>
            <th>Type</th>
            <th>Market</th>
            <th>Outcome</th>
            <th>Price</th>
            <th>Size</th>
            <th>Vs Mid</th>
          </tr>
        </thead>
        <tbody>
          {lines.slice(0, 40).map((line) => {
            const mid = line.row.bid != null && line.row.ask != null
              ? (line.row.bid + line.row.ask) / 2
              : null;
            const diff = mid != null ? line.price - mid : null;
            return (
              <tr key={line.key} className="clickable" onClick={() => onSelect(line.row.tokenId)}>
                <td><span className={line.type === 'BID' ? 'badge bid' : 'badge ofr'}>{line.type}</span></td>
                <td className="truncate" title={line.row.question}>{line.row.question}</td>
                <td className="dim">{line.row.outcome}</td>
                <td className={line.type === 'BID' ? 'num up' : 'num down'}>{px(line.price)}</td>
                <td className="num dim">{qty(line.size)}</td>
                <td className="num faint">{diff != null ? diff.toFixed(3) : '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
