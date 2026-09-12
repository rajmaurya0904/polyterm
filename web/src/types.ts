export type Level = [price: number, size: number];

export interface Book {
  bids: Level[];
  asks: Level[];
}

export interface Row {
  tokenId: string;
  marketId: string;
  outcomeIndex: number;
  question: string;
  slug: string;
  outcome: string;
  category: string;
  bid: number | null;
  ask: number | null;
  last: number | null;
  prevLast: number | null;
  /** Last trade sits outside the current spread, so the book is authoritative. */
  stale: boolean;
  spread: number | null;
  volume24h: number;
  liquidity: number;
  resolved: boolean;
  /** Terminal price once the oracle has ruled: 1 for the winner, 0 otherwise. */
  payout: number | null;
  book: Book | null;
  held: boolean;
}

export interface Position {
  tokenId: string;
  marketId: string;
  outcomeIndex: number;
  question: string;
  outcome: string;
  shares: number;
  cost: number;
  avgCost: number;
  mark: number | null;
  /** null when no live book exists — unknown, not zero. */
  unrealized: number | null;
  /** Market has closed upstream; the position settles once the oracle rules. */
  resolved: boolean;
}

export interface Account {
  balance: number;
  startingBalance: number;
  realized: number;
  deployed: number;
  equity: number;
}

export interface Snapshot {
  at: number;
  status: 'starting' | 'connecting' | 'live' | 'reconnecting';
  ticks: number;
  rows: Row[];
  positions: Position[];
  account: Account;
}

export interface Fill {
  price: number;
  size: number;
}

export interface Trade {
  id: number;
  at: string;
  tokenId: string;
  question: string;
  outcome: string;
  side: 'buy' | 'sell';
  /** Paid out at resolution rather than sold into the book. */
  settlement?: boolean;
  shares: number;
  filled: number;
  unfilled: number;
  avg: number;
  cost: number;
  fills: Fill[];
  realized: number;
}

export interface Preset {
  id: string;
  name: string;
  categories: string[];
}

export interface HistoryPoint {
  t: number;
  p: number;
}
