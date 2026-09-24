/**
 * api/dashboardServer.js
 * -----------------------------------------------------------------------
 * The bot-side half of the Synapse dashboard. The browser page can only
 * display things and send intents; everything that needs secrets or
 * in-memory engine state lives here:
 *
 *   - exchange API keys / execution      (ExecutionRouter)
 *   - live engine state per symbol       (SetupManager map)
 *   - kill switch / pause / emergency    (BotControl)
 *   - DB credentials                     (pg Pool)
 *
 * Read endpoints work with DASHBOARD_TOKEN unset only on localhost-style
 * dev setups; CONTROL endpoints are disabled unless DASHBOARD_TOKEN is set.
 *
 *   GET  /api/health                      no auth
 *   GET  /api/state                       full snapshot
 *   GET  /api/stream?token=               SSE: `state` every 2s, `event` on bot events
 *   GET  /api/candles?symbol=&tf=         candles for the chart
 *   GET  /api/trades?...                  closed trades (filters, paging)
 *   GET  /api/trade/:id                   one trade + lifecycle events
 *   POST /api/control        {action}     start | pause | stop | emergency
 *   POST /api/position/close {symbol,pct}
 *   POST /api/position/sl    {symbol,price}
 *   POST /api/position/tp    {symbol,tp1,tp2,tpFull}
 *   POST /api/order/cancel   {id}
 *   POST /api/settings       {weeklyLimit,riskPct,maxDailyLossPct,maxPositions,leverage}
 * -----------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STATUS = { RUNNING: 'running', PAUSED: 'paused', STOPPED: 'stopped', ERROR: 'error' };

/** Shared control flag the engine loop consults. Create once in main.js. */
class BotControl {
  constructor() {
    this.status = STATUS.RUNNING;
    this.lastAction = { text: 'Bot started', ts: Date.now() };
    this.lastSignal = null;
    this.lastError = null;
    this.events = []; // in-memory ring buffer of recent events, newest last
    this.listeners = new Set();
  }
  /** New entries allowed only while running. Exits/SL management always continue unless stopped. */
  entriesAllowed() { return this.status === STATUS.RUNNING; }
  engineAllowed() { return this.status !== STATUS.STOPPED; }
  set(status, text) {
    this.status = status;
    this.lastAction = { text, ts: Date.now() };
    this.push({ type: 'bot_' + status, level: status === STATUS.ERROR ? 'error' : 'info', text });
  }
  push(ev) {
    const e = { ts: Date.now(), level: 'info', ...ev };
    this.events.push(e);
    if (this.events.length > 500) this.events.shift();
    for (const fn of this.listeners) fn(e);
  }
  /** Feed SetupManager log entries here (call from the engine tick). */
  ingestSetupLog(setupManager, seenMap) {
    const from = seenMap.get(setupManager.symbol) ?? 0;
    for (const e of setupManager.log.slice(from)) {
      const map = {
        setup_created: ['signal', 'info', `${e.direction} order block identified`],
        entered_zone: ['signal', 'info', 'Price entered order-block zone'],
        confluence_flag: ['signal', 'info', `Confluence: ${e.flagName} (${e.bucket})`],
        setup_cancelled: ['setup_cancelled', 'warn', `Setup cancelled: ${e.reason}`],
        trade_entered: ['position_opened', 'success', `Position opened @ ${e.entryPrice}`],
        tp1_hit: ['take_profit', 'success', 'TP1 hit, 30% closed, SL moved to entry'],
        tp2_hit: ['take_profit', 'success', 'TP2 hit'],
        full_close: ['position_closed', 'success', 'Full take-profit, position closed'],
        sl_hit: ['stop_loss', 'error', 'Stop-loss triggered'],
        trade_closed: ['position_closed', 'warn', `Position closed: ${e.reason}`],
        setup_skipped: ['signal', 'info', e.reason === 'htf_ranging' ? `${e.direction ?? ''} setup skipped: HTF ranging` : e.reason === 'ob_score_too_low' ? `Order block skipped: score ${e.obScore}/100` : `Setup skipped: ${e.reason}`],
      }[e.type];
      if (!map) continue;
      this.push({ type: map[0], level: map[1], symbol: e.symbol, text: map[2], ts: e.time });
      if (map[0] === 'signal') this.lastSignal = { text: `${e.symbol} ${map[2]}`, ts: e.time };
      this.lastAction = { text: `${e.symbol} ${map[2]}`, ts: e.time };
    }
    seenMap.set(setupManager.symbol, setupManager.log.length);
  }
}

function createDashboardHandler(deps) {
  const {
    pool, router, setupManagers, settingsStore, tradeLimiter, control,
    adapters, getCandles, getTicker, dryRun, mode,
    token = process.env.DASHBOARD_TOKEN,
    staticDir = path.join(__dirname, '..', 'dashboard'),
    paperBalance = 10000,
  } = deps;

  // Loud, unmissable warning if this looks like a real deployment (Render
  // sets these env vars automatically) and no DASHBOARD_TOKEN is configured
  // — otherwise every read endpoint (trades, journal, live state, candles)
  // is served to anyone on the internet with no auth, silently.
  if (!token && (process.env.RENDER || process.env.RENDER_EXTERNAL_URL)) {
    const url = process.env.RENDER_EXTERNAL_URL || '(unknown URL)';
    console.warn(
      `\n🚨 DASHBOARD_TOKEN is not set — the dashboard read API is PUBLICLY\n` +
      `   exposed with no auth at ${url}/api/*\n` +
      `   Set DASHBOARD_TOKEN in the Render dashboard to lock it down.\n`
    );
  }

  const clients = new Set();
  const tickCache = new Map(); // symbol -> { at, data }
  const num = (v) => (v === null || v === undefined ? null : Number(v));

  // ---------- auth ----------
  function authOk(req, url) {
    if (!token) return { read: true, write: false };
    const given = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || url.searchParams.get('token') || '';
    const a = Buffer.from(given), b = Buffer.from(token);
    const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
    return { read: ok, write: ok };
  }

  // ---------- helpers ----------
  async function mark(symbol) {
    const hit = tickCache.get(symbol);
    if (hit && Date.now() - hit.at < 4000) return hit.data;
    try {
      const data = await getTicker(symbol); // { last, percentage, high, low, quoteVolume }
      tickCache.set(symbol, { at: Date.now(), data });
      return data;
    } catch { return hit?.data ?? null; }
  }

  async function getSetting(key, fallback) { return settingsStore.get(key, fallback); }

  async function buildState() {
    const [openTrades, closedAgg, openSetups, weekly] = await Promise.all([
      pool.query(`SELECT * FROM trades WHERE status='OPEN' ORDER BY opened_at DESC`),
      pool.query(`SELECT count(*)::int AS n, coalesce(sum(pnl),0) AS pnl,
                    count(*) FILTER (WHERE pnl>0)::int AS wins, count(*) FILTER (WHERE pnl<=0)::int AS losses,
                    coalesce(avg(pnl) FILTER (WHERE pnl>0),0) AS avg_win, coalesce(avg(pnl) FILTER (WHERE pnl<=0),0) AS avg_loss,
                    coalesce(sum(pnl) FILTER (WHERE pnl>0),0) AS gross_win, coalesce(sum(pnl) FILTER (WHERE pnl<=0),0) AS gross_loss,
                    coalesce(sum(pnl) FILTER (WHERE closed_at >= date_trunc('day', now())),0) AS pnl_today,
                    coalesce(sum(pnl) FILTER (WHERE closed_at >= date_trunc('week', now())),0) AS pnl_week,
                    coalesce(sum(pnl) FILTER (WHERE closed_at >= date_trunc('month', now())),0) AS pnl_month
                  FROM trades WHERE status='CLOSED' AND pnl IS NOT NULL`),
      pool.query(`SELECT s.*, coalesce((SELECT json_agg(json_build_object('bucket',c.bucket,'flag',c.flag_name,'at',c.fired_at))
                    FROM confluence_log c WHERE c.setup_id=s.id),'[]') AS flags
                  FROM setups s WHERE s.status IN ('OB_IDENTIFIED','IN_ZONE_AWAITING_CONFLUENCE','IN_TRADE','MANAGING_EXITS') ORDER BY s.created_at DESC`),
      tradeLimiter.canOpenNewTrade(),
    ]);

    const lev = await getSetting('leverage', 1);
    const riskPct = await getSetting('riskPct', 1);
    const maxDailyLossPct = await getSetting('maxDailyLossPct', 3);
    const maxPositions = await getSetting('maxPositions', 5);

    // balances: real adapters or dry-run adapters, per venue
    const venues = {};
    let standard = 0;
    await Promise.all(Object.entries(adapters).map(async ([name, ad]) => {
      try { venues[name] = Number(await ad.getBalance()); standard += venues[name]; }
      catch { venues[name] = null; }
    }));

    // positions
    const prices = {};
    const symbols = new Set([...openTrades.rows.map((t) => t.symbol), ...openSetups.rows.map((s) => s.symbol)]);
    await Promise.all([...symbols].map(async (s) => {
      const t = await mark(s);
      if (t) prices[s] = { last: t.last, chg24: t.percentage, high24: t.high, low24: t.low, vol24: t.quoteVolume };
    }));

    const positions = openTrades.rows.map((t) => {
      const long = t.direction === 'bullish';
      const entry = num(t.entry_price), rem = num(t.remaining_size);
      const m = prices[t.symbol]?.last ?? entry;
      const dir = long ? 1 : -1;
      const levP = Object.values(adapters).map((a) => a.leverageFor?.(t.symbol)).find(Boolean) ?? lev;
      const notional = rem * m;
      const margin = (rem * entry) / levP;
      const upnl = (m - entry) * rem * dir;
      // isolated-margin estimate; real liquidation comes from the venue
      const liq = (() => {
        // cross margin: equity backs the position, so liquidation is far away (estimate: equity split across open positions)
        if (Object.values(adapters).some((a) => a.marginMode === 'cross')) { const px = entry - dir * ((standard * 0.95) / Math.max(1, openTrades.rows.length)) / rem; return px > 0 ? px : null; }
        return levP > 1 ? entry * (1 - dir * (1 / levP) * 0.9) : null;
      })();
      return {
        id: t.id, setupId: t.setup_id, symbol: t.symbol, side: long ? 'long' : 'short',
        entry, mark: m, qty: num(t.size), remaining: rem, notional, leverage: levP, margin,
        upnl, roi: margin ? (upnl / margin) * 100 : 0,
        sl: num(t.sl), tp1: num(t.tp1), tp2: num(t.tp2), tpFull: num(t.tp_full),
        tp1Hit: t.tp1_hit, tp2Hit: t.tp2_hit, slBE: t.sl_moved_to_entry, liq,
        openedAt: new Date(t.opened_at).getTime(), venue: t.venue, strategy: 'Synapse SMC',
      };
    });

    // "Open orders": resting protective legs of open trades + waiting entries
    const orders = [];
    for (const p of positions) {
      const closing = p.side === 'long' ? 'sell' : 'buy';
      const leg = (kind, price, qtyFrac, hit) => orders.push({
        id: `${p.id}-${kind}`, tradeId: p.id, symbol: p.symbol, type: kind === 'SL' ? 'Stop market' : 'Take profit',
        side: closing, price, trigger: price, qty: p.qty * qtyFrac, filled: hit ? p.qty * qtyFrac : 0,
        status: hit ? 'filled' : 'pending', placedAt: p.openedAt, link: `${kind} for position #${p.id}`,
      });
      leg('SL', p.sl, 1, false);
      leg('TP1', p.tp1, 0.3, p.tp1Hit);
      leg('TP2', p.tp2, 0.21, p.tp2Hit);
      leg('TPF', p.tpFull, 0.49, false);
    }

    const setups = openSetups.rows.map((s) => {
      const flags = { mandatory: {}, optional: {} };
      for (const f of s.flags) flags[f.bucket][f.flag] = true;
      return {
        id: s.id, symbol: s.symbol, direction: s.direction, status: s.status,
        obLow: num(s.ob_low), obHigh: num(s.ob_high), entry: num(s.fib_entry), sl: num(s.fib_sl),
        tp1: num(s.fib_tp1), tp2: num(s.fib_tp2), tpFull: num(s.fib_tp_full),
        flags, createdAt: new Date(s.created_at).getTime(),
      };
    });
    // waiting entry orders
    for (const s of setups.filter((x) => x.status === 'IN_ZONE_AWAITING_CONFLUENCE')) {
      orders.push({
        id: `S${s.id}`, symbol: s.symbol, type: 'Conditional entry', side: s.direction === 'bullish' ? 'buy' : 'sell',
        price: s.entry, trigger: s.entry, qty: null, filled: 0, status: 'pending', placedAt: s.createdAt,
        link: `Awaiting confluence (${Object.keys(s.flags.mandatory).length}/3 + ${Object.keys(s.flags.optional).length}/2)`,
      });
    }

    const c = closedAgg.rows[0];
    const realized = Number(c.pnl);
    const unrealized = positions.reduce((a, p) => a + p.upnl, 0);
    const usedMargin = positions.reduce((a, p) => a + p.margin, 0);
    const base = paperBalance * Math.max(1, Object.keys(adapters).length);
    const totalNow = standard + unrealized;
    const roiOf = (x) => (base ? (x / base) * 100 : 0);
    const exposure = positions.reduce((a, p) => a + p.notional, 0);
    const dailyLoss = Math.min(0, Number(c.pnl_today) + unrealized);
    const maxDailyLoss = (standard * maxDailyLossPct) / 100;
    const usage = maxDailyLoss ? Math.abs(dailyLoss) / maxDailyLoss : 0;

    const risk = {
      exposure, exposurePct: totalNow ? (exposure / totalNow) * 100 : 0,
      marginUtil: totalNow ? (usedMargin / totalNow) * 100 : 0, leverage: lev,
      drawdown: null, // needs an equity history table; see README section "Equity curve"
      dailyLoss, maxDailyLoss: -maxDailyLoss, openPositions: positions.length, maxPositions,
      concentration: positions.map((p) => ({ symbol: p.symbol, pct: exposure ? (p.notional / exposure) * 100 : 0 })),
      weekly: { used: weekly.tradesThisWeek, limit: weekly.limit },
      status: usage >= 1 || !weekly.allowed ? 'breach' : usage >= 0.7 || positions.length >= maxPositions ? 'warn' : 'ok',
      riskPct,
    };

    const exchange = {};
    for (const name of Object.keys(adapters)) exchange[name] = venues[name] === null ? 'error' : 'ok';

    return {
      ts: Date.now(),
      bot: {
        status: control.status, strategy: 'Synapse SMC', dryRun, mode: mode ?? (dryRun ? 'paper' : 'live'),
        lastAction: control.lastAction, lastSignal: control.lastSignal, error: control.lastError,
        activePositions: positions.length, openOrders: orders.filter((o) => o.status === 'pending').length,
        dailyTrades: null, weeklyTrades: weekly.tradesThisWeek, weeklyLimit: weekly.limit,
        riskStatus: risk.status, exchange,
        pair: positions[0]?.symbol ?? setups[0]?.symbol ?? 'BTCUSDT',
      },
      prices, positions, orders, setups,
      balance: {
        total: totalNow, available: Math.max(0, standard - usedMargin), usedMargin,
        freeMargin: Math.max(0, totalNow - usedMargin), standard, floating: unrealized,
        realized, unrealized, equity: totalNow, venues,
      },
      stats: {
        roi: { cur: roiOf(realized + unrealized), today: roiOf(Number(c.pnl_today)), week: roiOf(Number(c.pnl_week)), month: roiOf(Number(c.pnl_month)), total: roiOf(realized) },
        realized, unrealized, trades: c.n, winRate: c.n ? (c.wins / c.n) * 100 : 0,
        avgWin: Number(c.avg_win), avgLoss: Number(c.avg_loss),
        profitFactor: Number(c.gross_loss) ? Number(c.gross_win) / Math.abs(Number(c.gross_loss)) : null,
        maxDD: null,
      },
      risk,
      events: control.events.slice(-100).reverse(),
    };
  }

  async function dbEvents(limit = 100) {
    const { rows } = await pool.query(
      `(SELECT s.created_at AS ts, 'signal' AS type, 'info' AS level, s.symbol, s.direction||' order block identified' AS text, 'S'||s.id AS ref FROM setups s)
       UNION ALL
       (SELECT s.closed_at, 'setup_cancelled', 'warn', s.symbol, 'Setup cancelled: '||coalesce(s.close_reason,''), 'S'||s.id FROM setups s WHERE s.status='CANCELLED' AND s.closed_at IS NOT NULL)
       UNION ALL
       (SELECT c.fired_at, 'signal', 'info', s.symbol, 'Confluence: '||c.flag_name||' ('||c.bucket||')', 'S'||s.id FROM confluence_log c JOIN setups s ON s.id=c.setup_id)
       UNION ALL
       (SELECT e.occurred_at, CASE e.event_type WHEN 'entry' THEN 'position_opened' WHEN 'sl_hit' THEN 'stop_loss' WHEN 'full_close' THEN 'position_closed' ELSE 'take_profit' END,
               CASE e.event_type WHEN 'sl_hit' THEN 'error' ELSE 'success' END, t.symbol, e.event_type, 'T'||t.id FROM trade_events e JOIN trades t ON t.id=e.trade_id)
       ORDER BY ts DESC LIMIT $1`, [limit]);
    return rows.map((r) => ({ ts: new Date(r.ts).getTime(), type: r.type, level: r.level, symbol: r.symbol, text: r.text, ref: r.ref }));
  }

  // ---------- control actions ----------
  async function closePosition(symbol, pct) {
    const sm = setupManagers.get(symbol);
    const setup = sm?.activeSetup;
    if (!setup?.trade) throw new Error(`No open position for ${symbol}`);
    const results = await router.mirrorClosePercentage(symbol, setup.direction, pct);
    if (!Object.values(results).some((r) => r.success)) throw new Error('Every venue rejected the close: ' + JSON.stringify(results));
    if (pct >= 100) {
      sm.onTradeEvent('trade_closed', { reason: 'manual_close' });
      setup.status = 'CLOSED';
      control.push({ type: 'position_closed', level: 'warn', symbol, text: 'Manually closed from dashboard' });
    } else {
      setup.trade.remainingSize = setup.trade.remainingSize * (1 - pct / 100);
      control.push({ type: 'position_reduced', level: 'warn', symbol, text: `Manually reduced ${pct}% from dashboard` });
    }
    return results;
  }

  async function emergencyStop() {
    control.set(STATUS.STOPPED, 'EMERGENCY STOP: closing all positions');
    const out = {};
    for (const [symbol, sm] of setupManagers) {
      if (sm.activeSetup?.trade && ['IN_TRADE', 'MANAGING_EXITS'].includes(sm.activeSetup.status)) {
        try { out[symbol] = await closePosition(symbol, 100); }
        catch (e) { out[symbol] = { error: e.message }; control.push({ type: 'error', level: 'error', symbol, text: 'Emergency close failed: ' + e.message }); }
      }
    }
    return out;
  }

  const routes = {
    'POST /api/control': async ({ action }) => {
      if (action === 'start') control.set(STATUS.RUNNING, 'Bot started from dashboard');
      else if (action === 'pause') control.set(STATUS.PAUSED, 'Bot paused: no new entries, exits still managed');
      else if (action === 'stop') control.set(STATUS.STOPPED, 'Bot stopped from dashboard');
      else if (action === 'emergency') return { closed: await emergencyStop() };
      else throw new Error('Unknown action');
      return { status: control.status };
    },
    'POST /api/position/close': async ({ symbol, pct }) => {
      if (!(pct > 0 && pct <= 100)) throw new Error('pct must be 1-100');
      return closePosition(symbol, Number(pct));
    },
    'POST /api/position/sl': async ({ symbol, price }) => {
      const p = Number(price); if (!(p > 0)) throw new Error('Invalid price');
      const setup = setupManagers.get(symbol)?.activeSetup;
      if (!setup?.trade) throw new Error('No open position');
      const long = setup.direction === 'bullish';
      if (long ? p >= setup.fib.tp1 : p <= setup.fib.tp1) throw new Error('SL must be on the losing side of TP1');
      await router.mirrorMoveStopLoss(symbol, p);
      setup.trade.sl = p;
      await pool.query(`UPDATE trades SET sl=$1 WHERE status='OPEN' AND symbol=$2`, [p, symbol]);
      control.push({ type: 'order_modified', level: 'info', symbol, text: `Stop-loss moved to ${p}` });
      return { ok: true };
    },
    'POST /api/position/tp': async ({ symbol, tp1, tp2, tpFull }) => {
      const setup = setupManagers.get(symbol)?.activeSetup;
      if (!setup?.trade) throw new Error('No open position');
      const f = setup.fib;
      const n = { tp1: Number(tp1 ?? f.tp1), tp2: Number(tp2 ?? f.tp2), tpFull: Number(tpFull ?? f.tpFull) };
      const long = setup.direction === 'bullish', e = setup.trade.entryPrice;
      const ordered = long ? e < n.tp1 && n.tp1 < n.tp2 && n.tp2 < n.tpFull : e > n.tp1 && n.tp1 > n.tp2 && n.tp2 > n.tpFull;
      if (!ordered) throw new Error('Targets must run entry -> TP1 -> TP2 -> full TP in trade direction');
      Object.assign(f, n); // exitMonitor reads fib each candle
      await pool.query(`UPDATE trades SET tp1=$1,tp2=$2,tp_full=$3 WHERE status='OPEN' AND symbol=$4`, [n.tp1, n.tp2, n.tpFull, symbol]);
      control.push({ type: 'order_modified', level: 'info', symbol, text: 'Take-profit targets updated' });
      return { ok: true };
    },
    'POST /api/order/cancel': async ({ id }) => {
      if (!String(id).startsWith('S')) throw new Error('Protective orders are managed by the position; close or modify the position instead');
      const sid = Number(String(id).slice(1));
      const { rows } = await pool.query(`SELECT symbol FROM setups WHERE id=$1`, [sid]);
      const sm = setupManagers.get(rows[0]?.symbol);
      if (sm?.activeSetup && sm.activeSetup.status === 'IN_ZONE_AWAITING_CONFLUENCE') {
        sm.activeSetup.status = 'CANCELLED';
        sm._emit('setup_cancelled', { reason: 'manual_cancel', direction: sm.activeSetup.direction });
      }
      await pool.query(`UPDATE setups SET status='CANCELLED', close_reason='manual_cancel', closed_at=now() WHERE id=$1`, [sid]);
      return { ok: true };
    },
    'POST /api/settings': async (b) => {
      const allowed = { weeklyLimit: null, riskPct: 'riskPct', maxDailyLossPct: 'maxDailyLossPct', maxPositions: 'maxPositions', leverage: 'leverage' };
      for (const [k, v] of Object.entries(b)) {
        if (!(k in allowed)) continue;
        const n = Number(v); if (!(n >= 0)) throw new Error(`Invalid ${k}`);
        if (k === 'weeklyLimit') await tradeLimiter.setLimit(Math.floor(n));
        else await settingsStore.set(allowed[k], n);
      }
      return { ok: true };
    },
  };

  function json(res, code, body) {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors });
    res.end(JSON.stringify(body));
  }
  const cors = { 'Access-Control-Allow-Origin': process.env.DASHBOARD_ORIGIN || '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let d = ''; req.on('data', (c) => { d += c; if (d.length > 1e5) reject(new Error('Body too large')); });
      req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(e); } });
    });
  }

  // SSE fan-out
  control.listeners.add((ev) => { for (const c of clients) c.write(`event: event\ndata: ${JSON.stringify(ev)}\n\n`); });
  setInterval(async () => {
    if (!clients.size) return;
    try {
      const s = await buildState();
      for (const c of clients) c.write(`event: state\ndata: ${JSON.stringify(s)}\n\n`);
    } catch (e) { control.lastError = e.message; }
  }, 2000);

  const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

  /** Returns true if the request was handled. Use from the existing http server in main.js. */
  return async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return true; }

    if (url.pathname === '/health') return false; // keep the existing health route
    if (url.pathname === '/api/health') { json(res, 200, { ok: true, dryRun, mode: mode ?? (dryRun ? 'paper' : 'live'), control: control.status, needsToken: !!token }); return true; }

    if (url.pathname.startsWith('/api/')) {
      const auth = authOk(req, url);
      if (!auth.read) { json(res, 401, { error: 'Missing or invalid token' }); return true; }
      try {
        if (req.method === 'GET' && url.pathname === '/api/state') { json(res, 200, { ...(await buildState()), events: await dbEvents(100) }); return true; }
        if (req.method === 'GET' && url.pathname === '/api/stream') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', ...cors });
          res.write(`event: state\ndata: ${JSON.stringify({ ...(await buildState()), events: await dbEvents(100) })}\n\n`);
          clients.add(res); req.on('close', () => clients.delete(res)); return true;
        }
        if (req.method === 'GET' && url.pathname === '/api/candles') {
          const symbol = (url.searchParams.get('symbol') || 'BTCUSDT').toUpperCase();
          const tf = url.searchParams.get('tf') || '1h';
          const c = await getCandles(symbol, tf);
          json(res, 200, { symbol, tf, candles: c.map((k) => ({ t: k.time, o: k.open, h: k.high, l: k.low, c: k.close, v: k.volume })) }); return true;
        }
        if (req.method === 'GET' && url.pathname === '/api/trades') {
          const q = url.searchParams; const where = [`status='CLOSED'`]; const p = [];
          if (q.get('symbol')) { p.push(q.get('symbol')); where.push(`symbol=$${p.length}`); }
          if (q.get('from')) { p.push(q.get('from')); where.push(`closed_at>=$${p.length}`); }
          if (q.get('to')) { p.push(q.get('to')); where.push(`closed_at<=$${p.length}`); }
          if (q.get('result') === 'win') where.push('pnl>0'); if (q.get('result') === 'loss') where.push('pnl<=0');
          if (q.get('q')) { p.push('%' + q.get('q') + '%'); where.push(`(symbol ILIKE $${p.length} OR id::text ILIKE $${p.length})`); }
          const sort = { closed_at: 'closed_at', pnl: 'pnl', symbol: 'symbol', opened_at: 'opened_at' }[q.get('sort')] || 'closed_at';
          const dir = q.get('dir') === 'asc' ? 'ASC' : 'DESC';
          const size = Math.min(200, Number(q.get('size')) || 25), page = Math.max(1, Number(q.get('page')) || 1);
          const total = (await pool.query(`SELECT count(*)::int n FROM trades WHERE ${where.join(' AND ')}`, p)).rows[0].n;
          const { rows } = await pool.query(`SELECT * FROM trades WHERE ${where.join(' AND ')} ORDER BY ${sort} ${dir} LIMIT ${size} OFFSET ${(page - 1) * size}`, p);
          json(res, 200, { total, page, size, rows }); return true;
        }
        const m = url.pathname.match(/^\/api\/trade\/(\d+)$/);
        if (req.method === 'GET' && m) {
          const t = (await pool.query(`SELECT * FROM trades WHERE id=$1`, [m[1]])).rows[0];
          if (!t) { json(res, 404, { error: 'Not found' }); return true; }
          const ev = (await pool.query(`SELECT event_type, data, occurred_at FROM trade_events WHERE trade_id=$1 ORDER BY occurred_at`, [m[1]])).rows;
          const setup = (await pool.query(`SELECT * FROM setups WHERE id=$1`, [t.setup_id])).rows[0];
          const flags = (await pool.query(`SELECT bucket, flag_name, fired_at FROM confluence_log WHERE setup_id=$1 ORDER BY fired_at`, [t.setup_id])).rows;
          json(res, 200, { trade: t, events: ev, setup, flags }); return true;
        }
        const handler = routes[`${req.method} ${url.pathname}`];
        if (handler) {
          if (!auth.write) { json(res, 403, { error: 'Control disabled: set DASHBOARD_TOKEN on the bot' }); return true; }
          const out = await handler(await readBody(req));
          control.push({ type: 'dashboard_action', level: 'info', text: `${req.method} ${url.pathname}` });
          json(res, 200, out); return true;
        }
        json(res, 404, { error: 'Unknown endpoint' }); return true;
      } catch (e) { json(res, 400, { error: e.message }); return true; }
    }

    // static dashboard
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/dashboard' || url.pathname.startsWith('/dashboard/'))) {
      const file = url.pathname === '/' || url.pathname === '/dashboard' ? 'index.html' : url.pathname.replace('/dashboard/', '');
      const full = path.join(staticDir, path.normalize(file).replace(/^(\.\.[/\\])+/, ''));
      if (full.startsWith(staticDir) && fs.existsSync(full)) {
        res.writeHead(200, { 'Content-Type': mime[path.extname(full)] || 'application/octet-stream' });
        fs.createReadStream(full).pipe(res); return true;
      }
    }
    return false;
  };
}

module.exports = { createDashboardHandler, BotControl, STATUS };
