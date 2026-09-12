import { useEffect, useState } from 'react';
import { Panel } from '../components/Panel';
import { compact, px } from '../format';
import type { Row } from '../types';

interface SearchResult {
  id: string;
  question: string;
  slug: string;
  volume24h: number;
  watched: boolean;
}

interface Props {
  rows: Row[];
  onSelect: (tokenId: string) => void;
}

/**
 * Full market list plus search-and-add.
 *
 * Adding a market tells the server to widen its watch set — it resolves the
 * outcome tokens, subscribes them on the upstream socket and starts polling
 * their books, so the new rows appear on the next snapshot.
 */
export function MarketsView({ rows, onSelect }: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Debounced search — Gamma is rate-limited and the user types faster than it answers.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setResults([]); return; }

    let cancelled = false;
    setSearching(true);
    const handle = window.setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
        const data = await res.json();
        if (!cancelled) setResults((data.markets ?? []) as SearchResult[]);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 350);

    return () => { cancelled = true; window.clearTimeout(handle); };
  }, [query]);

  const watch = async (marketId: string) => {
    setAdding(marketId);
    setError(null);
    try {
      const res = await fetch('/api/watch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ marketId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Could not add market');
      setResults((prev) => prev.map((r) => (r.id === marketId ? { ...r, watched: true } : r)));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setAdding(null);
    }
  };

  // One line per market rather than per outcome.
  const markets = new Map<string, Row[]>();
  for (const row of rows) {
    const list = markets.get(row.marketId) ?? [];
    list.push(row);
    markets.set(row.marketId, list);
  }

  return (
    <div className="stack">
      <Panel title="Add a market">
        <div className="form-row">
          <input
            className="search"
            placeholder="Search Polymarket — e.g. bitcoin, election, premier league…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {searching && <span className="faint">searching…</span>}
        </div>

        {error && <div className="notice error" style={{ marginTop: 8 }}>{error}</div>}

        {results.length > 0 && (
          <div className="scroll-x" style={{ marginTop: 10 }}>
            <table>
              <thead>
                <tr><th>Market</th><th>24h Vol</th><th /></tr>
              </thead>
              <tbody>
                {results.map((result) => (
                  <tr key={result.id}>
                    <td className="truncate wide" title={result.question}>{result.question}</td>
                    <td className="num dim">{compact(result.volume24h)}</td>
                    <td>
                      <button
                        className="btn"
                        disabled={result.watched || adding === result.id}
                        onClick={() => watch(result.id)}
                      >
                        {result.watched ? 'Watching' : adding === result.id ? 'Adding…' : 'Watch'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {query.trim().length >= 2 && !searching && !results.length && (
          <div className="empty">No markets found</div>
        )}
      </Panel>

      <Panel title={`Watching · ${markets.size} markets`} flush>
        <div className="scroll-x">
          <table>
            <thead>
              <tr>
                <th>Market</th>
                <th>Category</th>
                <th>Outcomes</th>
                <th>Best bid</th>
                <th>24h Vol</th>
                <th>Liquidity</th>
              </tr>
            </thead>
            <tbody>
              {[...markets.values()].map((group) => {
                const head = group[0];
                return (
                  <tr key={head.marketId} className="clickable" onClick={() => onSelect(head.tokenId)}>
                    <td className="truncate wide" title={head.question}>
                      {head.question}
                      {group.some((r) => r.held) && <span className="badge mkt" style={{ marginLeft: 6 }}>POS</span>}
                    </td>
                    <td className="dim">{head.category}</td>
                    <td className="dim">{group.map((r) => r.outcome).join(' / ')}</td>
                    <td className="num up">{px(head.bid)}</td>
                    <td className="num dim">{compact(head.volume24h)}</td>
                    <td className="num dim">{compact(head.liquidity)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
