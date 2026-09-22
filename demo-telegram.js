/**
 * demo-telegram.js
 * -----------------------------------------------------------------------
 * Tests the parts of the Telegram layer that don't need real network
 * access: message formatting (messages.js) and journal queries
 * (journalQueries.js), using the same mock-pool pattern as
 * demo-journal.js. This validates everything except the actual
 * grammY <-> Telegram API calls, which need to run on a real host.
 * -----------------------------------------------------------------------
 */

const { detectStructure } = require('./core/structure');
const { computeFibLevels } = require('./core/fibonacci');
const { SetupManager } = require('./core/setupManager');
const { Journal } = require('./journal/journal');
const { formatEngineEvent } = require('./telegram/messages');
const { getRecentTrades, getJournalForSymbol, getStats, formatTradesList, formatJournal, formatStats } = require('./telegram/journalQueries');

// --- In-memory mock Postgres: enough SQL awareness to serve these
// --- specific queries against data inserted via Journal. Not a real
// --- SQL engine — just enough logic to prove the query/format wiring
// --- works end to end without needing a live database.
function createInMemoryPool() {
  const setups = [];
  const trades = [];
  let setupSeq = 1;
  let tradeSeq = 1;

  return {
    async query(sql, params = []) {
      const s = sql.trim();

      if (s.startsWith('INSERT INTO setups')) {
        const [symbol, venue, direction, ob_low, ob_high, fib_entry, fib_sl, fib_tp1, fib_tp2, fib_tp_full] = params;
        const row = {
          id: setupSeq++, symbol, venue, direction, ob_low, ob_high,
          fib_entry, fib_sl, fib_tp1, fib_tp2, fib_tp_full,
          status: 'OB_IDENTIFIED', close_reason: null, created_at: new Date(), closed_at: null,
        };
        setups.push(row);
        return { rows: [{ id: row.id }] };
      }

      if (s.startsWith('UPDATE setups SET status')) {
        const [status, closeReason, id] = params;
        const row = setups.find((r) => r.id === id);
        if (row) { row.status = status; row.close_reason = closeReason; if (['CLOSED','CANCELLED'].includes(status)) row.closed_at = new Date(); }
        return { rows: [] };
      }

      if (s.startsWith('INSERT INTO trades')) {
        const [setup_id, symbol, venue, direction, entry_price, size, sl, tp1, tp2, tp_full] = params;
        const row = {
          id: tradeSeq++, setup_id, symbol, venue, direction, entry_price, size, sl, tp1, tp2, tp_full,
          status: 'OPEN', pnl: null, opened_at: new Date(), closed_at: null,
        };
        trades.push(row);
        return { rows: [{ id: row.id }] };
      }

      if (s.startsWith('INSERT INTO confluence_log') || s.startsWith('INSERT INTO trade_events')) {
        return { rows: [] };
      }

      if (s.startsWith("UPDATE trades SET tp1_hit")) return { rows: [] };
      if (s.startsWith("UPDATE trades SET tp2_hit")) return { rows: [] };
      if (s.startsWith("UPDATE trades SET status = 'CLOSED'")) {
        const [id, pnl] = params;
        const row = trades.find((r) => r.id === id);
        if (row) { row.status = 'CLOSED'; row.pnl = pnl; row.closed_at = new Date(); }
        return { rows: [] };
      }

      if (s.startsWith('SELECT symbol, venue, direction, entry_price')) {
        return { rows: [...trades].sort((a, b) => b.opened_at - a.opened_at).slice(0, params[0]) };
      }

      if (s.startsWith('SELECT id, direction, status, close_reason')) {
        const [symbol, limit] = params;
        return { rows: setups.filter((s2) => s2.symbol === symbol).sort((a, b) => b.created_at - a.created_at).slice(0, limit) };
      }

      if (s.startsWith('SELECT') && s.includes('closed_count')) {
        const closed = trades.filter((t) => t.status === 'CLOSED');
        const scored = closed.filter((t) => t.pnl !== null);
        const wins = scored.filter((t) => t.pnl > 0);
        const losses = scored.filter((t) => t.pnl <= 0);
        const avg = scored.length ? scored.reduce((sum, t) => sum + t.pnl, 0) / scored.length : null;
        return {
          rows: [{
            closed_count: closed.length, scored_count: scored.length,
            wins: wins.length, losses: losses.length, avg_pnl: avg,
            open_count: trades.filter((t) => t.status === 'OPEN').length,
          }],
        };
      }

      return { rows: [] };
    },
  };
}

function buildCandles(raw) {
  return raw.map(([open, high, low, close], i) => ({ time: i, open, high, low, close, volume: 1000 }));
}

async function main() {
  const raw = [
    [100, 102, 96, 97], [97, 98, 92, 93], [93, 94, 88, 89], [89, 90, 85, 86], [86, 87, 80, 83],
    [83, 91, 81, 90], [90, 93, 88, 92], [92, 92, 84, 88], [88, 96, 87, 95], [95, 104, 94, 103],
    [103, 112, 102, 111], [111, 122, 110, 120],
    [120, 121, 108, 110], [110, 111, 100, 101], // trailing candles so #11's high registers as a swing
  ];
  const candles = buildCandles(raw);
  const events = detectStructure(candles, 1);

  const pool = createInMemoryPool();
  const journal = new Journal(pool);
  const mgr = new SetupManager('BTCUSDT');

  // Create the setup, walk through confluence and a full trade lifecycle.
  mgr.onStructureEvent(candles, events[0], computeFibLevels(events[0]));
  mgr.onPriceUpdate(candles[8], 8);
  mgr.onConfluenceFlag('mandatory', 'waveTrendDot');
  mgr.onConfluenceFlag('mandatory', 'mfi');
  mgr.onConfluenceFlag('mandatory', 'vwap');
  mgr.onConfluenceFlag('optional', 'rsi');
  mgr.onConfluenceFlag('optional', 'frvp');
  mgr.enterTrade(84, 1.0);
  mgr.onTradeEvent('tp1_hit', {});
  mgr.onTradeEvent('full_close', { pnl: 42.5 });

  await journal.syncLog(mgr, 'bybit');

  console.log('=== Telegram message formatting for each engine event ===\n');
  for (const entry of mgr.log) {
    const msg = formatEngineEvent(entry);
    if (msg) console.log(msg + '\n---');
  }

  console.log('\n=== /trades ===');
  console.log(formatTradesList(await getRecentTrades(pool, 10)));

  console.log('\n=== /journal BTCUSDT ===');
  console.log(formatJournal('BTCUSDT', await getJournalForSymbol(pool, 'BTCUSDT', 20)));

  console.log('\n=== /stats ===');
  console.log(formatStats(await getStats(pool)));
}

main();
