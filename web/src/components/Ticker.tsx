import type { Row } from '../types';
import { px } from '../format';

/**
 * Scrolling strip of the day's biggest movers. The track is duplicated so the
 * CSS translate loop has no visible seam.
 */
export function Ticker({ rows }: { rows: Row[] }) {
  const items = rows
    .filter((r) => r.last != null && r.bid != null)
    .slice(0, 18)
    .map((r) => ({
      key: r.tokenId,
      text: `${r.outcome.toUpperCase()} · ${r.question.slice(0, 48)}`,
      value: px(r.bid),
      dir: r.prevLast != null && r.last != null ? Math.sign(r.last - r.prevLast) : 0,
    }));

  if (!items.length) return null;

  return (
    <div className="ticker">
      <span className="ticker-tag">LIVE</span>
      <div className="ticker-track">
        {[0, 1].map((copy) =>
          items.map((item) => (
            <span className="ticker-item" key={`${copy}-${item.key}`}>
              {item.text}{' '}
              <strong className={item.dir > 0 ? 'up' : item.dir < 0 ? 'down' : ''}>{item.value}</strong>
            </span>
          )),
        )}
      </div>
    </div>
  );
}
