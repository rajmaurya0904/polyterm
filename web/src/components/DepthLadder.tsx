import type { Book } from '../types';
import { qty } from '../format';

/**
 * Order-book ladder. Bar width is proportional to size at that level, so
 * depth imbalance is visible at a glance.
 */
export function DepthLadder({ book, depth = 6 }: { book: Book | null; depth?: number }) {
  if (!book || (!book.bids.length && !book.asks.length)) {
    return <div className="empty">No resting orders</div>;
  }

  const asks = book.asks.slice(0, depth).reverse();
  const bids = book.bids.slice(0, depth);
  const max = Math.max(...[...asks, ...bids].map(([, size]) => size), 1);

  const bestBid = bids[0]?.[0] ?? null;
  const bestAsk = book.asks[0]?.[0] ?? null;
  const midPrice = bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : null;
  const spread = bestBid != null && bestAsk != null ? bestAsk - bestBid : null;

  return (
    <div className="ladder">
      {asks.map(([price, size]) => (
        <div className="lvl ask" key={`a${price}`}>
          <div className="bar" style={{ width: `${(size / max) * 100}%` }} />
          <span className="px">{price.toFixed(3)}</span>
          <span className="dim">{qty(size)}</span>
        </div>
      ))}

      <div className="ladder-mid">
        {midPrice != null ? `mid ${midPrice.toFixed(4)}` : 'one-sided book'}
        {spread != null && <span className="faint"> · spread {spread.toFixed(3)}</span>}
      </div>

      {bids.map(([price, size]) => (
        <div className="lvl bid" key={`b${price}`}>
          <div className="bar" style={{ width: `${(size / max) * 100}%` }} />
          <span className="px">{price.toFixed(3)}</span>
          <span className="dim">{qty(size)}</span>
        </div>
      ))}
    </div>
  );
}
