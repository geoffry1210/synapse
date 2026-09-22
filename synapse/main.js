/**
 * main.js
 * -----------------------------------------------------------------------
 * Real wiring for production/paper-trading use. Reads config from
 * environment variables, sets up the DB pool, execution adapters (real
 * or dry-run based on DRY_RUN), the Telegram bot, a health-check HTTP
 * server (for Render's health checks + UptimeRobot pings, since Render's
 * free tier spins a service down after 15 min with no inbound HTTP
 * traffic), and runs three independent scheduled jobs:
 *
 *   1. Per-symbol engine cycle (runSymbolCycle) — every POLL_INTERVAL_MS,
 *      for each whitelisted symbol.
 *   2. Pump/dump scanner sweep — every SCAN_INTERVAL_MS, across the full
 *      symbol universe (not whitelist-restricted).
 *   3. Max holding period sweep — every HOLD_CHECK_INTERVAL_MS.
 *
 * Not runnable inside this sandbox (no network to exchanges/Telegram/a
 * real DB), but every piece it wires together has been independently
 * tested — see the demo-*.js files. Run this on Render (as a Web
 * Service, so the health server satisfies Render's port-binding
 * requirement) with real env vars set, and point UptimeRobot at
 * https://<your-app>.onrender.com/health every 5 minutes.
 * -----------------------------------------------------------------------
 */

const { Pool } = require('pg');
const ccxt = require('ccxt');
const http = require('http');

const { WhitelistFilter } = require('./filters/whitelist');
const { SetupManager } = require('./core/setupManager');
const { SettingsStore } = require('./core/settingsStore');
const { TradeLimiter } = require('./core/tradeLimiter');
const { enforceMaxHoldingPeriod } = require('./core/maxHoldingPeriod');
const { runSymbolCycle } = require('./core/engineCycle');
const { fetchCandlesFor, buildScannerUniverse, fetchMarketCapTiers } = require('./core/dataSource');
const { Journal } = require('./journal/journal');
const { CcxtAdapter } = require('./execution/ccxtAdapter');
const { Mt5Adapter } = require('./execution/mt5Adapter');
const { DryRunAdapter } = require('./execution/dryRunAdapter');
const { ExecutionRouter } = require('./execution/executionRouter');
const { TradingBot } = require('./telegram/bot');
const { scanMarket } = require('./scanner/scanner');
const { createDashboardHandler, BotControl } = require('./api/dashboardServer');

const DRY_RUN = process.env.DRY_RUN !== 'false'; // default to dry-run/paper-trading for safety
const BYBIT_DEMO = process.env.BYBIT_DEMO === 'true'; // Bybit Demo Trading: real prices, fake funds, real order flow
const EXEC_MODE = BYBIT_DEMO ? 'demo' : DRY_RUN ? 'paper' : 'live';
/** Parses a numeric env var, falling back to `fallback` if unset OR empty/invalid —
 *  guards against Render (and others) sometimes storing a blank dashboard field as
 *  an empty string rather than omitting it, which would otherwise silently become 0. */
function envNumber(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

const POLL_INTERVAL_MS = envNumber('POLL_INTERVAL_MS', 60_000);
const SCAN_INTERVAL_MS = envNumber('SCAN_INTERVAL_MS', 5 * 60_000);
const HOLD_CHECK_INTERVAL_MS = envNumber('HOLD_CHECK_INTERVAL_MS', 60 * 60_000);
const PAPER_BALANCE = envNumber('PAPER_BALANCE', 10_000); // starting simulated balance per venue in DRY_RUN mode
const SIGNAL_TIMEFRAME = process.env.SIGNAL_TIMEFRAME ?? '1h'; // candle interval the main engine reasons about
const HTF_BIAS_ENABLED = process.env.HTF_BIAS_ENABLED !== 'false'; // daily+4H trend-agreement filter (htfBias.js) — was wired in engineCycle.js but never actually called with data until this fix
const ENTRY_MODEL = process.env.ENTRY_MODEL === 'confirmation' ? 'confirmation' : 'aggressive'; // 'aggressive' = Model 1 (original). 'confirmation' = Model 2, needs a matching LTF CHoCH inside the zone too
const MIN_OB_SCORE = envNumber('MIN_OB_SCORE', 50); // 0-100 orderblockValidator score floor
const LTF_TIMEFRAME = process.env.LTF_TIMEFRAME ?? '15m'; // only fetched when ENTRY_MODEL=confirmation

/** "BTCUSDT" -> "BTC/USDT" (ccxt's unified symbol format). Assumes a USDT-quoted pair. */
function toCcxtSymbol(symbol) {
  return symbol.endsWith('USDT') ? `${symbol.slice(0, -4)}/USDT` : symbol;
}

function buildExecutionAdapters() {
  if (BYBIT_DEMO) {
    if (!process.env.BYBIT_DEMO_API_KEY || !process.env.BYBIT_DEMO_SECRET) throw new Error('BYBIT_DEMO=true needs BYBIT_DEMO_API_KEY and BYBIT_DEMO_SECRET (create them while in Bybit Demo Trading mode).');
    console.log('🧪 Synapse is using BYBIT DEMO TRADING: real prices, fake funds, real order flow on api-demo.bybit.com. Other venues are disabled.');
    return {
      bybit: new CcxtAdapter('bybit', { apiKey: process.env.BYBIT_DEMO_API_KEY, secret: process.env.BYBIT_DEMO_SECRET, demo: true, market: 'swap', maxLeverageCap: process.env.BYBIT_MAX_LEVERAGE ? Number(process.env.BYBIT_MAX_LEVERAGE) : undefined }),
    };
  }
  if (DRY_RUN) {
    console.log(
      `⚠️  Synapse is running in DRY_RUN mode (paper trading, $${PAPER_BALANCE} per venue, real live prices, no real orders placed). Set DRY_RUN=false to go live.`
    );
    return {
      bybit: new DryRunAdapter('bybit', PAPER_BALANCE),
      mexc: new DryRunAdapter('mexc', PAPER_BALANCE),
      bitget: new DryRunAdapter('bitget', PAPER_BALANCE),
      weex: new DryRunAdapter('weex', PAPER_BALANCE),
    };
  }

  return {
    bybit: new CcxtAdapter('bybit', { apiKey: process.env.BYBIT_API_KEY, secret: process.env.BYBIT_SECRET, market: 'swap', maxLeverageCap: process.env.BYBIT_MAX_LEVERAGE ? Number(process.env.BYBIT_MAX_LEVERAGE) : undefined }),
    mexc: new CcxtAdapter('mexc', { apiKey: process.env.MEXC_API_KEY, secret: process.env.MEXC_SECRET }),
    bitget: new CcxtAdapter('bitget', {
      apiKey: process.env.BITGET_API_KEY,
      secret: process.env.BITGET_SECRET,
      password: process.env.BITGET_PASSPHRASE,
    }),
    weex: new CcxtAdapter('weex', { apiKey: process.env.WEEX_API_KEY, secret: process.env.WEEX_SECRET }),
    // MT5 needs an explicit connect() call before use — done in main() below.
  };
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const journal = new Journal(pool);
  const settingsStore = new SettingsStore(pool);
  const tradeLimiter = new TradeLimiter(pool, settingsStore);
  const whitelist = new WhitelistFilter();

  const adapters = buildExecutionAdapters();

  if (!DRY_RUN && !BYBIT_DEMO && process.env.MT5_TOKEN && process.env.MT5_ACCOUNT_ID) {
    const mt5 = new Mt5Adapter(process.env.MT5_TOKEN, process.env.MT5_ACCOUNT_ID);
    await mt5.connect();
    adapters.mt5 = mt5;
  }

  const router = new ExecutionRouter(adapters, { mode: 'per_venue', riskPct: envNumber('RISK_PCT', 1) }, settingsStore);

  // Market data (OHLCV, symbol lists) uses its own public, no-auth ccxt
  // instances — independent of DRY_RUN, since even paper trading should
  // run against real prices. Bybit is the reference signal source; both
  // Bybit and Weex feed the scanner's exchange-wide sweep.
  const marketData = { bybit: new ccxt.bybit(), weex: new ccxt.weex() };

  async function getCandles(symbol) {
    return fetchCandlesFor(marketData.bybit, toCcxtSymbol(symbol), SIGNAL_TIMEFRAME, 200);
  }

  // HTF bias (daily+4H) and, when ENTRY_MODEL=confirmation, LTF candles for
  // Entry Model 2 — both were accepted by engineCycle.js's opts but never
  // supplied from here, so those filters silently never ran. Cached per
  // symbol since daily/4H structure barely changes minute to minute;
  // refetching every 60s tick would be wasted API calls for no benefit.
  const htfCache = new Map(); // symbol -> { daily: {data,at}, fourHour: {data,at} }
  const HTF_DAILY_TTL_MS = 30 * 60_000;
  const HTF_4H_TTL_MS = 5 * 60_000;
  async function getHtfCandles(symbol) {
    const now = Date.now();
    const entry = htfCache.get(symbol) ?? {};
    if (!entry.daily || now - entry.daily.at > HTF_DAILY_TTL_MS) {
      entry.daily = { data: await fetchCandlesFor(marketData.bybit, toCcxtSymbol(symbol), '1d', 90), at: now };
    }
    if (!entry.fourHour || now - entry.fourHour.at > HTF_4H_TTL_MS) {
      entry.fourHour = { data: await fetchCandlesFor(marketData.bybit, toCcxtSymbol(symbol), '4h', 180), at: now };
    }
    htfCache.set(symbol, entry);
    return { daily: entry.daily.data, fourHour: entry.fourHour.data };
  }

  const ltfCache = new Map(); // symbol -> { data, at }
  const LTF_TTL_MS = 60_000;
  async function getLtfCandles(symbol) {
    const now = Date.now();
    const cached = ltfCache.get(symbol);
    if (cached && now - cached.at <= LTF_TTL_MS) return cached.data;
    const data = await fetchCandlesFor(marketData.bybit, toCcxtSymbol(symbol), LTF_TIMEFRAME, 200);
    ltfCache.set(symbol, { data, at: now });
    return data;
  }

  // One SetupManager per whitelisted symbol, kept alive across ticks.
  const setupManagers = new Map(whitelist.getList().map((symbol) => [symbol, new SetupManager(symbol)]));

  const telegramBot = process.env.TELEGRAM_BOT_TOKEN
    ? new TradingBot(process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_CHAT_ID, pool, tradeLimiter, {
        getCandles,
        getSetupManager: (symbol) => setupManagers.get(symbol),
      })
    : null;
  if (telegramBot) telegramBot.start();

  // --- Dashboard integration ---
  const control = new BotControl();
  const logSeen = new Map();
  const dashboard = createDashboardHandler({
    pool, router, setupManagers, settingsStore, tradeLimiter, control, adapters,
    dryRun: DRY_RUN && !BYBIT_DEMO, mode: EXEC_MODE, paperBalance: PAPER_BALANCE,
    getCandles: (symbol, tf = SIGNAL_TIMEFRAME) => fetchCandlesFor(marketData.bybit, toCcxtSymbol(symbol), tf, 300),
    getTicker: (symbol) => marketData.bybit.fetchTicker(toCcxtSymbol(symbol)),
  });

  // --- Job 1: per-symbol engine cycle ---
  // Overlap guard: if a full pass across all whitelisted symbols hasn't
  // finished by the time the next interval fires, skip that tick rather
  // than starting a second pass on top of it — this is what let sweeps
  // compound into runaway resource usage and crash-loop restarts before.
  let engineCycleRunning = false;
  async function tickSymbol(symbol) {
    try {
      const candles = await getCandles(symbol);

      let htfCandles;
      if (HTF_BIAS_ENABLED) {
        try { htfCandles = await getHtfCandles(symbol); }
        catch (err) { console.warn(`HTF candle fetch failed for ${symbol}, running this tick without the bias filter: ${err.message}`); }
      }

      let ltfCandles;
      if (ENTRY_MODEL === 'confirmation') {
        try { ltfCandles = await getLtfCandles(symbol); }
        catch (err) { console.warn(`LTF candle fetch failed for ${symbol}, confirmation entries paused for this tick: ${err.message}`); }
      }

      await runSymbolCycle(candles, {
        setupManager: setupManagers.get(symbol),
        router,
        journal,
        tradeLimiter,
        telegramBot,
        venueLabel: 'multi',
        control,
      }, {
        htfCandles,
        entryModel: ENTRY_MODEL,
        minObScore: MIN_OB_SCORE,
        ltfCandles,
      });
      control.ingestSetupLog(setupManagers.get(symbol), logSeen);
    } catch (err) {
      console.error(`Engine cycle failed for ${symbol}:`, err.message);
    }
  }

  setInterval(async () => {
    if (!control.engineAllowed()) return;
    if (engineCycleRunning) {
      console.warn('Engine cycle still running from the previous tick — skipping this one.');
      return;
    }
    engineCycleRunning = true;
    try {
      for (const symbol of setupManagers.keys()) await tickSymbol(symbol);
    } finally {
      engineCycleRunning = false;
    }
  }, POLL_INTERVAL_MS);

  // --- Job 2: pump/dump scanner sweep (exchange-wide, not whitelist-restricted) ---
  // This sweeps hundreds of symbols across Bybit + Weex, which can easily take
  // longer than SCAN_INTERVAL_MS to finish on constrained free-tier hosting —
  // without the overlap guard below, a second sweep would start on top of an
  // unfinished first one, compounding indefinitely into a resource/crash spiral.
  // SCANNER_ENABLED=false is a fast kill-switch (no redeploy) if this job is
  // ever suspected of causing instability again.
  const SCANNER_ENABLED = process.env.SCANNER_ENABLED !== 'false';
  let scannerRunning = false;
  let cachedTiers = null;
  let cachedTiersAt = 0;
  const TIER_CACHE_MS = 30 * 60_000; // market-cap rank barely changes minute to minute — refetch at most every 30 min, not every scan cycle
  let lastTiersAvailable = true; // only notify on a state change, not every cycle

  if (SCANNER_ENABLED) {
    setInterval(async () => {
      if (scannerRunning) {
        console.warn('Scanner sweep still running from the previous cycle — skipping this one.');
        return;
      }
      scannerRunning = true;
      try {
        let tiers = cachedTiers;
        let tiersAvailable = true;
        let tierError = null;
        if (!tiers || Date.now() - cachedTiersAt > TIER_CACHE_MS) {
          try {
            tiers = await fetchMarketCapTiers();
            cachedTiers = tiers;
            cachedTiersAt = Date.now();
          } catch (err) {
            tiersAvailable = false;
            tierError = err.message;
            tiers = cachedTiers ?? new Map(); // fall back to the last good cache if we have one
          }
        }

        if (tiersAvailable !== lastTiersAvailable && telegramBot) {
          await telegramBot.notify(
            tiersAvailable
              ? '✅ Market-cap tiering (CoinGecko) is working again — scanner priority weighting restored.'
              : `⚠️ Market-cap tiering (CoinGecko) failed — scanner alerts may default to "low" tier priority until this resolves. Error: ${tierError}`
          );
        }
        lastTiersAvailable = tiersAvailable;

        const { universe } = await buildScannerUniverse(marketData, { timeframe: '1h', candleLimit: 30, precomputedTiers: tiers });
        const alerts = scanMarket(universe, { windowCandles: 24, thresholdPct: 30 });
        for (const alert of alerts) {
          if (telegramBot) await telegramBot.notifyScannerAlert(alert);
        }
      } catch (err) {
        console.error('Scanner sweep failed:', err.message);
      } finally {
        scannerRunning = false;
      }
    }, SCAN_INTERVAL_MS);
  } else {
    console.log('⚠️  Scanner disabled via SCANNER_ENABLED=false.');
  }

  // --- Job 3: max holding period sweep ---
  let holdingSweepRunning = false;
  setInterval(async () => {
    if (holdingSweepRunning) return;
    holdingSweepRunning = true;
    try {
      const closed = await enforceMaxHoldingPeriod(pool, router, journal, { maxDays: 7 });
      for (const trade of closed) {
        if (telegramBot) await telegramBot.notify(`⏰ Force-closed ${trade.symbol} — held ${trade.ageDays.toFixed(1)} days (max 7)`);
      }
    } catch (err) {
      console.error('Max holding period sweep failed:', err.message);
    } finally {
      holdingSweepRunning = false;
    }
  }, HOLD_CHECK_INTERVAL_MS);

  // --- Health server: satisfies Render's Web Service port requirement,
  // --- and gives UptimeRobot something to ping every 5 min to keep the
  // --- free-tier instance from spinning down after 15 min idle. Reports
  // --- basic liveness — not a deep health check, since a slow DB/exchange
  // --- shouldn't make Render think the whole process is dead and restart it.
  const PORT = envNumber('PORT', 3000);
  const server = http.createServer(async (req, res) => {
    if (await dashboard(req, res)) return;
    if (req.url === '/health' || req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', dryRun: DRY_RUN, uptimeSeconds: process.uptime() }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  server.listen(PORT, () => console.log(`Health server listening on port ${PORT} (GET /health)`));

  console.log('Synapse is running.');
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
