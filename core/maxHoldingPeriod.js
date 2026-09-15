/**
 * maxHoldingPeriod.js
 * -----------------------------------------------------------------------
 * Force-closes any OPEN trade that's been running longer than the max
 * holding period (default 7 days), regardless of where price is
 * relative to TP/SL. Meant to run on a periodic schedule (e.g. hourly
 * cron / setInterval in the main process) — see demo-limits.js for the
 * wiring pattern.
 * -----------------------------------------------------------------------
 */

const DEFAULT_MAX_DAYS = 7;

/**
 * @param {{ query: (sql: string, params?: any[]) => Promise<any> }} pool
 * @param {import('./executionRouter').ExecutionRouter} executionRouter
 * @param {import('../journal/journal').Journal} journal
 * @param {{ maxDays?: number }} opts
 * @returns {Promise<{ symbol: string, tradeId: number, ageDays: number }[]>} trades that were force-closed
 */
async function enforceMaxHoldingPeriod(pool, executionRouter, journal, opts = {}) {
  const maxDays = opts.maxDays ?? DEFAULT_MAX_DAYS;

  const { rows: staleTrades } = await pool.query(
    `SELECT id, setup_id, symbol, direction, opened_at,
            EXTRACT(EPOCH FROM (now() - opened_at)) / 86400 AS age_days
     FROM trades
     WHERE status = 'OPEN' AND opened_at <= now() - ($1 || ' days')::interval`,
    [maxDays]
  );

  const closed = [];

  for (const trade of staleTrades) {
    try {
      await executionRouter.mirrorClosePercentage(trade.symbol, trade.direction, 100);
      await journal.logTradeEvent(trade.id, 'full_close', { reason: 'max_holding_period_exceeded' });
      await journal.updateSetupStatus(trade.setup_id, 'CLOSED', 'max_holding_period_exceeded');
      closed.push({ symbol: trade.symbol, tradeId: trade.id, ageDays: Number(trade.age_days) });
    } catch (err) {
      // Don't let one venue/trade failure stop the rest of the sweep.
      console.error(`Failed to force-close stale trade ${trade.id} (${trade.symbol}):`, err.message);
    }
  }

  return closed;
}

module.exports = { enforceMaxHoldingPeriod, DEFAULT_MAX_DAYS };
