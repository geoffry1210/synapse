# Synapse dashboard: bot integration

Files
- `api/dashboardServer.js`  (new)  bot-side API + SSE + control endpoints + static hosting
- `dashboard/index.html`    (new)  the terminal UI, single file, no build step

## Why the bot owns the hard parts
The web page cannot hold exchange keys, place or close orders, see the in-memory SetupManagers,
or enforce a kill switch. The bot does all of that; the page only shows state and sends intents.

## 1. main.js changes

At the top:
```js
const { createDashboardHandler, BotControl } = require('./api/dashboardServer');
```

Inside `main()`, after `setupManagers` and `telegramBot` exist:
```js
const control = new BotControl();
const logSeen = new Map();
const dashboard = createDashboardHandler({
  pool, router, setupManagers, settingsStore, tradeLimiter, control, adapters,
  dryRun: DRY_RUN, paperBalance: PAPER_BALANCE,
  getCandles: (symbol, tf = SIGNAL_TIMEFRAME) => fetchCandlesFor(marketData.bybit, toCcxtSymbol(symbol), tf, 300),
  getTicker: (symbol) => marketData.bybit.fetchTicker(toCcxtSymbol(symbol)),
});
```

In `tickSymbol`, pass control and feed events (after runSymbolCycle):
```js
await runSymbolCycle(candles, { ...existingDeps, control });
control.ingestSetupLog(setupManagers.get(symbol), logSeen);
```

Engine loop (Job 1): skip when stopped:
```js
if (!control.engineAllowed()) return;   // first line inside the setInterval callback
```

Health server: try the dashboard first.
```js
const server = http.createServer(async (req, res) => {
  if (await dashboard(req, res)) return;
  /* ...existing /health and 404 handling... */
});
```

## 2. core/engineCycle.js (3 lines)
Destructure `control` from deps and gate entries only:
```js
const { setupManager, router, journal, tradeLimiter, telegramBot, venueLabel, control } = deps;
...
if (setup && setup.status === 'IN_ZONE_AWAITING_CONFLUENCE') {
  ...
  if (setupManager.hasFullConfluence()) {
    if (control && !control.entriesAllowed()) { /* paused: skip entry, keep setup alive */ }
    else { /* existing tradeLimiter + mirrorEntry block */ }
```
Exits and stop management keep running while paused. Stopped halts the whole loop.

## 3. Environment
- `DASHBOARD_TOKEN` (required for any control action; without it the API is read-only)
- `DASHBOARD_ORIGIN` (optional CORS origin if the page is hosted elsewhere)

Open `https://<your-render-app>/` and enter the token under Settings.

## 4. Known gaps (schema, not UI)
- No `exit_price`, `fees` or `leverage` columns: exit shown as average derived from P&L, fees as n/a, leverage from the `leverage` setting.
- No equity history table: max drawdown shows n/a until you add one (a snapshot row per hour is enough).
- Positions are mirrored across venues but stored as one row (`venue = 'multi'`), so the dashboard shows the combined position.
- Liquidation price is an estimate from leverage; the venue's value is authoritative.
- `/api/order/cancel` only cancels conditional entries; protective legs are managed via the position.
