# PolyTerm

A live trading terminal for [Polymarket](https://polymarket.com) prediction markets — real-time
prices, order-book depth, and paper trading. **No wallet, no API keys, no real orders.**

Built on Polymarket's public endpoints. Nothing in this project signs a transaction or
authenticates against the trading API; there is no code path that can place a real order.

![MIT](https://img.shields.io/badge/license-MIT-blue) ![Node](https://img.shields.io/badge/node-%3E%3D20-green)

---

## What it does

- **Live quote board** — top markets by 24h volume, grouped by category, flashing on each tick
- **Order-book ladder** — depth bars, mid price, spread
- **Price history chart** — multi-series, crosshair, value pills (hand-rolled SVG, no chart library)
- **Blotter** — top-of-book bid/offer lines with resting size
- **Paper trading** — orders filled against the live book, with positions marked continuously
- **Presets & filters** — saved category views, faceted multi-select
- **Light / dark** — token-driven, persisted

## Pages

| Page | What's there |
| --- | --- |
| **Board** | Three-column terminal — quote grid, price chart, blotter, depth ladder, paper ticket |
| **Markets** | Every watched market, plus search to add any Polymarket market to the live feed |
| **Blotter** | Full-width two-sided quotes, sortable by spread, resting size or volume |
| **Positions** | Stat tiles, mark-to-market, one-click close, account reset |
| **History** | Trade log; expand a row to see the individual fills it walked |

## Quick start

```bash
git clone https://github.com/rajmaurya0904/polyterm.git
cd polyterm
npm install
npm run dev
```

Open <http://localhost:5173>. No configuration, no account, no keys.

| Command | What it does |
| --- | --- |
| `npm run dev` | API on `:4010` and web on `:5173`, both watching |
| `npm run build` | Production build of the web app |
| `npm start` | Serve the built app from the API server |

### Configuration

All optional:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `4010` | API / relay port |
| `TOP_MARKETS` | `24` | Markets loaded at startup |
| `BOOK_REFRESH_MS` | `4000` | Order-book poll interval |
| `HOST` | `127.0.0.1` | Bind address. Set `0.0.0.0` to expose on your LAN — there is no auth |
| `MAX_OUTCOMES` | `200` | Cap on watched outcomes (each costs one book request per refresh) |

## Architecture

```
Polymarket public APIs
   Gamma  · market discovery & metadata
   CLOB   · order books, price history
   WS     · live trade pushes
            |
            v
   server/  Node + Express + ws
            holds ONE upstream socket, polls books,
            simulates paper fills, fans state out
            |
            |  local WebSocket, ~1 snapshot/sec
            v
   web/     React + TypeScript + Vite
```

**Why a relay?** A browser cannot hold the exchange feed directly — page CSP and the exchange's
own origin rules both prevent it. One server-side socket also means ten open tabs cost the
upstream feed one connection, not ten.

**Why both a socket and REST polling?** They carry different things. The socket delivers trades
immediately but only intermittent book snapshots, and its last-trade price can drift outside the
current spread on fast-moving markets. REST is authoritative for depth. The UI treats bid/ask as
truth and marks a last price that falls outside the spread as stale (`*`), because presenting a
stale quote as live is worse than showing nothing.

## Paper trading

Orders are filled locally by walking the live book, level by level, until filled or the limit is
crossed. A thin book produces real slippage — a 2,000-share order might consume seven price levels
and fill well above the best ask. Partial fills are reported rather than invented away.

State lives in `data/paper.json`. Delete it to reset.

What it deliberately does **not** model:

- **Queue position** — your limit fills instantly if the price is there; in reality you wait in line
- **Fees and gas**
- **Market impact** — the book doesn't react to your order
- **Settlement** — positions never resolve to $1.00 or $0.00, only mark-to-market

Fills are therefore optimistic. Direction and spread cost are realistic; absolute returns flatter you.

## Reading the numbers

- Prices are probabilities from 0 to 1. `$0.190` means the market implies a 19% chance.
- Positions mark at **best bid** — your exit price — so a new position shows a loss immediately.
  That's the spread, not an error.
- A position with no live book shows `—`, never `$0.00`. Unknown is not zero, and it is excluded
  from the total rather than silently counted as flat.
- A resolved market's book returns 404 upstream; those rows are labelled `resolved`.

## Project layout

```
server/src/
  index.js       API, relay, snapshot assembly
  polymarket.js  public endpoint access & normalisation
  socket.js      upstream socket with backoff
  paper.js       fill simulation & position accounting
web/src/
  App.tsx        shell, routing, board composition
  views/         Markets, Blotter, Positions, History
  components/    Panel, QuoteTable, Blotter, PriceChart,
                 DepthLadder, PaperPanel, Shell, Ticker
  hooks/         useLiveSnapshot, useTrades
  theme.css      design tokens
```

## Contributing

Issues and pull requests welcome. Good first areas: more data adapters (Kalshi, Manifold), a
resolution/settlement model for paper positions, saved layouts, alerting.

Please keep the read-only guarantee intact — no signing, no private keys, no order submission.

## Disclaimer

For research and education. Not financial advice. Paper results do not predict real returns, for
all the reasons listed above and several more.

## License

MIT — see [LICENSE](LICENSE).
