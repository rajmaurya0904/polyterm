import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLiveSnapshot } from './hooks/useLiveSnapshot';
import { FacetFilter, PresetMenu, Sidebar } from './components/Shell';
import { Panel } from './components/Panel';
import { QuoteTable } from './components/QuoteTable';
import { Blotter } from './components/Blotter';
import { DepthLadder } from './components/DepthLadder';
import { PriceChart, type Series } from './components/PriceChart';
import { AccountSummary, OrderTicket, Positions } from './components/PaperPanel';
import { Ticker } from './components/Ticker';
import { MarketsView } from './views/MarketsView';
import { BlotterView } from './views/BlotterView';
import { PositionsView } from './views/PositionsView';
import { HistoryView } from './views/HistoryView';
import { useTrades } from './hooks/useTrades';
import { compact } from './format';
import type { HistoryPoint, Preset, Row } from './types';

const SERIES_COLORS = ['#1a6dff', '#0f9d58', '#d9a441', '#d93b2b'];
const THEME_KEY = 'polyterm:theme';
const PRESET_KEY = 'polyterm:presets';

function loadPresets(): Preset[] {
  try {
    const raw = localStorage.getItem(PRESET_KEY);
    return raw ? (JSON.parse(raw) as Preset[]) : [];
  } catch {
    return [];
  }
}

export default function App() {
  const { snapshot, connected } = useLiveSnapshot();
  const [view, setView] = useState('board');
  const [categories, setCategories] = useState<string[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [presets, setPresets] = useState<Preset[]>(loadPresets);
  const [activePreset, setActivePreset] = useState<string | null>(null);
  const [theme, setTheme] = useState(() => localStorage.getItem(THEME_KEY) ?? 'dark');
  const [history, setHistory] = useState<Record<string, HistoryPoint[]>>({});
  const [loadingHistory, setLoadingHistory] = useState(false);
  // Bumped whenever a paper order lands, so the trade log refetches.
  const [tradeVersion, setTradeVersion] = useState(0);
  const { trades, loading: loadingTrades } = useTrades(tradeVersion);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem(PRESET_KEY, JSON.stringify(presets));
  }, [presets]);

  const rows = snapshot?.rows ?? [];

  const allCategories = useMemo(
    () => [...new Set(rows.map((r) => r.category))].sort(),
    [rows],
  );

  const visibleRows = useMemo(
    () => (categories.length ? rows.filter((r) => categories.includes(r.category)) : rows),
    [rows, categories],
  );

  // Default the selection to the most active market once data arrives.
  useEffect(() => {
    if (selectedId || !visibleRows.length) return;
    setSelectedId(visibleRows[0].tokenId);
  }, [visibleRows, selectedId]);

  const selected: Row | null = useMemo(
    () => rows.find((r) => r.tokenId === selectedId) ?? null,
    [rows, selectedId],
  );

  /**
   * Fetch history for every outcome of the selected market, so a binary market
   * charts both legs. Cached by token; the series are static enough that
   * refetching on every tick would be wasteful.
   */
  const siblings = useMemo(
    () => (selected ? rows.filter((r) => r.marketId === selected.marketId) : []),
    [rows, selected],
  );

  useEffect(() => {
    const missing = siblings.filter((r) => !history[r.tokenId]);
    if (!missing.length) return;

    let cancelled = false;
    setLoadingHistory(true);
    Promise.all(
      missing.map(async (row) => {
        const res = await fetch(`/api/history/${row.tokenId}?interval=1w`);
        const data = await res.json();
        return [row.tokenId, (data.history ?? []) as HistoryPoint[]] as const;
      }),
    )
      .then((entries) => {
        if (cancelled) return;
        setHistory((prev) => ({ ...prev, ...Object.fromEntries(entries) }));
      })
      .catch(() => { /* chart shows its empty state */ })
      .finally(() => !cancelled && setLoadingHistory(false));

    return () => { cancelled = true; };
  }, [siblings, history]);

  const series: Series[] = siblings
    .map((row, i) => ({
      id: row.tokenId,
      label: row.outcome,
      color: SERIES_COLORS[i % SERIES_COLORS.length],
      points: history[row.tokenId] ?? [],
    }))
    .filter((s) => s.points.length > 0);

  const applyPreset = useCallback((preset: Preset) => {
    setCategories(preset.categories);
    setActivePreset(preset.id);
  }, []);

  const savePreset = useCallback((name: string) => {
    const preset: Preset = { id: String(Date.now()), name, categories };
    setPresets((prev) => [...prev, preset]);
    setActivePreset(preset.id);
  }, [categories]);

  const feedState = snapshot?.status ?? 'starting';
  const dotClass = !connected ? 'dot' : feedState === 'live' ? 'dot live' : 'dot connecting';

  return (
    <div className="app">
      <Sidebar active={view} onSelect={setView} />

      <div className="main">
        <header className="topbar">
          <span className="status">
            <span className={dotClass} />
            {!connected ? 'relay offline' : feedState === 'live' ? 'live' : feedState}
          </span>

          <span className="chip">
            <span className="label">Ticks</span>
            <span className="value">{snapshot?.ticks ?? 0}</span>
          </span>

          <FacetFilter
            label="Category"
            options={allCategories}
            selected={categories}
            onChange={(next) => { setCategories(next); setActivePreset(null); }}
          />

          {categories.map((category) => (
            <span className="chip" key={category}>
              <span className="value">{category}</span>
              <button
                onClick={() => setCategories((prev) => prev.filter((c) => c !== category))}
                aria-label={`Remove ${category}`}
              >
                ✕
              </button>
            </span>
          ))}

          <PresetMenu
            presets={presets}
            activeId={activePreset}
            onApply={applyPreset}
            onSave={savePreset}
            onRemove={(id) => setPresets((prev) => prev.filter((p) => p.id !== id))}
          />

          <span className="spacer" />

          <span className="chip">
            <span className="label">Markets</span>
            <span className="value">{visibleRows.length}</span>
          </span>

          <button className="btn" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
            {theme === 'dark' ? '☀ Light' : '☾ Dark'}
          </button>
        </header>

        {view === 'board' ? (
          <div className="board">
            <div className="col">
              <Panel
                title="Markets"
                flush
                actions={<span className="faint" style={{ fontSize: 11 }}>by 24h volume</span>}
              >
                <QuoteTable rows={visibleRows} selected={selectedId} onSelect={setSelectedId} />
              </Panel>
            </div>

            <div className="col">
              <Panel
                title={selected ? selected.question : 'Price history'}
                actions={
                  selected && (
                    <span className="faint" style={{ fontSize: 11 }}>
                      {compact(selected.volume24h)} · 24h
                    </span>
                  )
                }
              >
                <PriceChart series={series} loading={loadingHistory && !series.length} />
              </Panel>

              <Panel title="Blotter" flush>
                <Blotter rows={visibleRows} onSelect={setSelectedId} />
              </Panel>

              <Panel title="Positions" flush>
                <Positions positions={snapshot?.positions ?? []} onSelect={setSelectedId} />
              </Panel>
            </div>

            <div className="col">
              <Panel title="Order book" flush>
                <DepthLadder book={selected?.book ?? null} />
              </Panel>

              <Panel title="Paper ticket">
                <OrderTicket row={selected} onPlaced={() => setTradeVersion((v) => v + 1)} />
              </Panel>

              {snapshot && (
                <Panel title="Account">
                  <AccountSummary account={snapshot.account} />
                </Panel>
              )}
            </div>
          </div>
        ) : (
          <div className="page">
            {view === 'markets' && (
              <MarketsView
                rows={visibleRows}
                onSelect={(id) => { setSelectedId(id); setView('board'); }}
              />
            )}
            {view === 'blotter' && (
              <BlotterView
                rows={visibleRows}
                onSelect={(id) => { setSelectedId(id); setView('board'); }}
              />
            )}
            {view === 'positions' && snapshot && (
              <PositionsView
                positions={snapshot.positions}
                account={snapshot.account}
                onSelect={(id) => { setSelectedId(id); setView('board'); }}
                onChanged={() => setTradeVersion((v) => v + 1)}
              />
            )}
            {view === 'history' && <HistoryView trades={trades} loading={loadingTrades} />}
          </div>
        )}

        <Ticker rows={rows} />
      </div>
    </div>
  );
}
