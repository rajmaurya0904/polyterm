import { useCallback, useEffect, useState } from 'react';
import type { Trade } from '../types';

/**
 * Paper trade log. Refetched on demand rather than streamed — trades only
 * change when this browser places one, or when the file is reset.
 */
export function useTrades(refreshKey: number) {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/paper/trades');
      const data = await res.json();
      setTrades((data.trades ?? []) as Trade[]);
    } catch {
      // Keep whatever was already shown.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load, refreshKey]);

  return { trades, loading, reload: load };
}
