import { useEffect, useRef } from 'react';
import type { Row } from '../types';
import { compact, px } from '../format';

interface Props {
  rows: Row[];
  selected: string | null;
  onSelect: (tokenId: string) => void;
}

/**
 * Dense quote grid, grouped by category.
 *
 * Rows flash on a price change. The flash is driven by a ref rather than state
 * so a re-render every second doesn't re-trigger the animation on every row.
 */
export function QuoteTable({ rows, selected, onSelect }: Props) {
  const previous = useRef<Record<string, number | null>>({});

  useEffect(() => {
    const next: Record<string, number | null> = {};
    for (const row of rows) next[row.tokenId] = row.last;
    previous.current = next;
  });

  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const list = groups.get(row.category) ?? [];
    list.push(row);
    groups.set(row.category, list);
  }

  if (!rows.length) return <div className="empty">No markets match these filters</div>;

  return (
    <div className="scroll-x">
      <table>
        <thead>
          <tr>
            <th>Market</th>
            <th>Outcome</th>
            <th>Bid</th>
            <th>Ask</th>
            <th>Last</th>
            <th>Spread</th>
            <th>24h Vol</th>
          </tr>
        </thead>
        <tbody>
          {[...groups.entries()].map(([category, list]) => (
            <Group
              key={category}
              category={category}
              rows={list}
              selected={selected}
              onSelect={onSelect}
              previous={previous.current}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface GroupProps extends Props {
  category: string;
  previous: Record<string, number | null>;
}

function Group({ category, rows, selected, onSelect, previous }: GroupProps) {
  return (
    <>
      <tr className="group-row">
        <td colSpan={7}>
          {category} <span className="faint">· {rows.length}</span>
        </td>
      </tr>
      {rows.map((row) => {
        const before = previous[row.tokenId];
        const flash =
          before != null && row.last != null && row.last !== before
            ? row.last > before ? 'flash-up' : 'flash-down'
            : '';
        const classes = ['clickable', flash, row.tokenId === selected ? 'selected' : '']
          .filter(Boolean)
          .join(' ');

        return (
          <tr key={row.tokenId} className={classes} onClick={() => onSelect(row.tokenId)}>
            <td className="truncate" title={row.question}>
              {row.question}
              {row.held && <span className="badge mkt" style={{ marginLeft: 6 }}>POS</span>}
              {row.resolved && <span className="faint" style={{ marginLeft: 6 }}>resolved</span>}
            </td>
            <td className="dim">{row.outcome}</td>
            <td className="num up">{px(row.bid)}</td>
            <td className="num down">{px(row.ask)}</td>
            <td
              className={row.stale ? 'num faint' : 'num'}
              title={row.stale ? 'Stale — last trade is outside the current spread' : undefined}
            >
              {px(row.last)}{row.stale ? '*' : ''}
            </td>
            <td className="num dim">{row.spread != null ? row.spread.toFixed(3) : '—'}</td>
            <td className="num dim">{compact(row.volume24h)}</td>
          </tr>
        );
      })}
    </>
  );
}
