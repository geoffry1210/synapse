# Synapse

A multi-exchange SMC (Smart Money Concepts) trading bot with Telegram
control, mirrored execution across Bybit, MEXC, Bitget, Weex, and an MT5
prop account, plus a standalone pump/dump scanner.

## Strategy

- HTF structure (BOS/CHoCH) identifies major order blocks (no FVG)
- Fib levels (anchored on the full structure leg) define entry/SL/TP
- Entry requires the Cipher B mandatory trio (WaveTrend @ ±45, MFI, VWAP)
  plus 2-of-4 optional confluences (RSI, StochRSI, FRVP, candle patterns)
- Opposing setups override each other; only one direction active per symbol
- Scaled exits: TP1 (30%, SL→breakeven), TP2 (30% of remainder), full TP
- Positions force-close after 7 days; a settable weekly trade cap applies

## Project layout

```
core/         structure detection, order blocks, fib, setup state machine,
              exit monitoring, trade/holding-period limits, data source
indicators/   RSI, StochRSI, WaveTrend, VWAP, MFI, FRVP, candle patterns,
              divergence
confluence/   Cipher B + optional confluence evaluation
execution/    ccxt adapter (Bybit/MEXC/Bitget/Weex), MT5 (MetaApi) adapter,
              dry-run/paper-trading adapter, execution router, risk sizing
filters/      major-pairs whitelist
scanner/      pump detector, dump-probability scorer, market-wide sweep
journal/      Postgres schema + journal writer
charts/       candlestick chart rendering (OB zone, fib levels)
telegram/     grammY bot — commands, notifications, chart snapshots
main.js       real entry point: wires everything, runs on a schedule
demo-*.js     tests/integration tests for each module (no live network needed)
```

## Setup

```bash
npm install
```

Required environment variables (see `main.js` for the full list):

- `DATABASE_URL` — Postgres connection string (run `journal/schema.sql` against it first)
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`
- `DRY_RUN` — defaults to `true` (paper trading, no real orders). Set to `false` to go live.
- Exchange keys (only needed when `DRY_RUN=false`): `BYBIT_API_KEY`/`BYBIT_SECRET`,
  `MEXC_API_KEY`/`MEXC_SECRET`, `BITGET_API_KEY`/`BITGET_SECRET`/`BITGET_PASSPHRASE`,
  `WEEX_API_KEY`/`WEEX_SECRET`, `MT5_TOKEN`/`MT5_ACCOUNT_ID`
- `PORT` — set automatically by most hosts (e.g. Render); used by the built-in
  `/health` endpoint

```bash
npm start
```

## Testing without live infrastructure

Every module has a corresponding `demo-*.js` that exercises it against
synthetic data or mocked dependencies — no exchange/Telegram/DB connection
needed. Run any of them directly, e.g.:

```bash
node demo-main.js          # full pipeline integration test
node demo-execution.js     # execution router + partial-failure isolation
node demo-chart.js         # generates sample chart PNGs
```

## Deployment notes

- Defaults to `DRY_RUN=true` — verify behavior in paper-trading mode before
  ever setting `DRY_RUN=false`.
- The `/health` endpoint exists so free-tier hosts (e.g. Render) can be kept
  alive via an external pinger (e.g. UptimeRobot hitting it every 5 minutes).
- Telegram `/togglecharts` disables chart-image notifications if bandwidth
  is constrained; `/chart <SYMBOL>` still works on demand.
- `execution/mt5Adapter.js` is unverified against a live MetaApi account —
  check current SDK docs before relying on it.
