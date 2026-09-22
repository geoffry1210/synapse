/**
 * demo-limits.js
 * -----------------------------------------------------------------------
 * Tests SettingsStore + TradeLimiter (weekly cap) and
 * enforceMaxHoldingPeriod (7-day forced close) against an in-memory mock
 * pool — no real Postgres needed. Uses DryRunAdapter + ExecutionRouter
 * for the actual "close the stale position" side effect.
 * -----------------------------------------------------------------------
 */

const { SettingsStore } = require('./core/settingsStore');
const { TradeLimiter, startOfWeekUTC } = require('./core/tradeLimiter');
const { enforceMaxHoldingPeriod } = require('./core/maxHoldingPeriod');
const { Journal } = require('./journal/journal');
const { DryRunAdapter } = require('./execution/dryRunAdapter');
const { ExecutionRouter } = require('./execution/executionRouter');

function createMockPool() {
  const settings = new Map();
  const trades = [
    // A trade opened 9 days ago -> should get force-closed (stale)
    { id: 1, setup_id: 101, symbol: 'BTCUSDT', direction: 'bullish', status: 'OPEN', opened_at: daysAgo(9) },
    // A trade opened 2 days ago -> should stay open (not stale yet)
    { id: 2, setup_id: 102, symbol: 'ETHUSDT', direction: 'bearish', status: 'OPEN', opened_at: daysAgo(2) },
    // A trade opened 3 days ago -> counts toward this week's limit
    { id: 3, setup_id: 103, symbol: 'SOLUSDT', direction: 'bullish', status: 'CLOSED', opened_at: daysAgo(3) },
  ];

  function daysAgo(n) {
    return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
  }

  return {
    trades,
    async query(sql, params = []) {
      const s = sql.trim();

      if (s.startsWith('SELECT value FROM bot_settings')) {
        const [key] = params;
        return settings.has(key) ? { rows: [{ value: settings.get(key) }] } : { rows: [] };
      }
      if (s.startsWith('INSERT INTO bot_settings')) {
        const [key, value] = params;
        settings.set(key, JSON.parse(value));
        return { rows: [] };
      }

      if (s.startsWith('SELECT COUNT(*) AS count FROM trades WHERE opened_at >=')) {
        const [weekStart] = params;
        const count = trades.filter((t) => t.opened_at >= weekStart).length;
        return { rows: [{ count: String(count) }] };
      }

      if (s.includes('EXTRACT(EPOCH FROM (now() - opened_at))')) {
        const [maxDays] = params;
        const cutoff = new Date(Date.now() - maxDays * 24 * 60 * 60 * 1000);
        const stale = trades
          .filter((t) => t.status === 'OPEN' && t.opened_at <= cutoff)
          .map((t) => ({ ...t, age_days: (Date.now() - t.opened_at.getTime()) / 86400000 }));
        return { rows: stale };
      }

      if (s.startsWith('INSERT INTO trade_events')) return { rows: [] };
      if (s.startsWith("UPDATE trades SET status = 'CLOSED'")) {
        const [id] = params;
        const t = trades.find((tr) => tr.id === id);
        if (t) t.status = 'CLOSED';
        return { rows: [] };
      }
      if (s.startsWith('UPDATE setups SET status')) return { rows: [] };

      return { rows: [] };
    },
  };
}

async function main() {
  const pool = createMockPool();
  const settingsStore = new SettingsStore(pool);
  const limiter = new TradeLimiter(pool, settingsStore);

  console.log('=== Weekly trade limiter ===\n');
  console.log('Default limit check:', await limiter.canOpenNewTrade());

  await limiter.setLimit(3);
  console.log('After setLimit(3):', await limiter.canOpenNewTrade());

  await limiter.setLimit(1);
  console.log('After setLimit(1) (should now be blocked, 1+ trade already this week):', await limiter.canOpenNewTrade());

  console.log(`\nWeek boundary used: ${startOfWeekUTC(new Date()).toISOString()} (Monday 00:00 UTC)`);

  console.log('\n=== Max holding period enforcement (7 days) ===\n');
  const bybit = new DryRunAdapter('bybit', 10000);
  bybit.setPrice('BTCUSDT', 84);
  await bybit.placeMarketOrder('BTCUSDT', 'buy', 5); // simulate the stale position actually existing on the venue

  const router = new ExecutionRouter({ bybit });
  // Manually register the tracked position so the router knows to close it
  // (in the real system this is set by mirrorEntry when the trade first opened).
  router._trackPosition('BTCUSDT', 'bybit', { orderId: 'x', slOrderId: 'y', side: 'buy', size: 5 });

  const journal = new Journal(pool);
  const closed = await enforceMaxHoldingPeriod(pool, router, journal, { maxDays: 7 });

  console.log('Force-closed trades:', closed);
  console.log('Trade #1 status after sweep:', pool.trades.find((t) => t.id === 1).status);
  console.log('Trade #2 status after sweep (should still be OPEN, only 2 days old):', pool.trades.find((t) => t.id === 2).status);
}

main();
