/** Shared number formatting. Prices are 0–1 probabilities; money is USD. */

export const px = (n: number | null | undefined): string =>
  n == null ? '—' : `$${n.toFixed(3)}`;

export const usd = (n: number | null | undefined): string =>
  n == null ? '—' : `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`;

export const pct = (n: number | null | undefined): string =>
  n == null ? '—' : `${n > 0 ? '+' : ''}${(n * 100).toFixed(1)}%`;

export const qty = (n: number | null | undefined): string =>
  n == null ? '—' : Math.round(n).toLocaleString();

export const compact = (n: number | null | undefined): string => {
  if (n == null) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
};

/** Implied probability of an outcome, from its mid price. */
export const mid = (bid: number | null, ask: number | null): number | null => {
  if (bid != null && ask != null) return (bid + ask) / 2;
  return bid ?? ask ?? null;
};
