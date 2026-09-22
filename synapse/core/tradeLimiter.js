/**
 * tradeLimiter.js
 * -----------------------------------------------------------------------
 * Caps the number of NEW trades the engine may open in a calendar week
 * (Monday 00:00 UTC through the following Monday 00:00 UTC). Checked
 * before every entry — if the cap is already hit, the setup still forms
 * and can sit IN_ZONE_AWAITING_CONFLUENCE, but ExecutionRouter.mirrorEntry
 * is simply not called until next week (see demo-limits.js for the
 * wiring point).
 *
 * The count is read live from the `trades` table (opened_at this week)
 * rather than an in-memory counter, so it survives restarts and stays
 * correct even if the bot redeploys mid-week.
 *
 * The limit itself is stored via SettingsStore under the key
 * 'weeklyTradeLimit' so it's settable live via a Telegram command
 * without a redeploy.
 * -----------------------------------------------------------------------
 */

const SETTINGS_KEY = 'weeklyTradeLimit';
const DEFAULT_LIMIT = 5; // placeholder — set your real number via /setweeklylimit

/**
 * Monday 00:00 UTC of the week containing `date`.
 * @param {Date} date
 * @returns {Date}
 */
function startOfWeekUTC(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay(); // 0 = Sunday, 1 = Monday, ...
  const diffToMonday = day === 0 ? 6 : day - 1;
  d.setUTCDate(d.getUTCDate() - diffToMonday);
  return d;
}

class TradeLimiter {
  /**
   * @param {{ query: (sql: string, params?: any[]) => Promise<any> }} pool
   * @param {import('./settingsStore').SettingsStore} settingsStore
   */
  constructor(pool, settingsStore) {
    this.pool = pool;
    this.settingsStore = settingsStore;
  }

  async getLimit() {
    return this.settingsStore.get(SETTINGS_KEY, DEFAULT_LIMIT);
  }

  async setLimit(n) {
    if (!Number.isInteger(n) || n < 0) throw new Error('Weekly trade limit must be a non-negative integer');
    await this.settingsStore.set(SETTINGS_KEY, n);
  }

  /**
   * @returns {Promise<{ allowed: boolean, tradesThisWeek: number, limit: number }>}
   */
  async canOpenNewTrade() {
    const limit = await this.getLimit();
    const weekStart = startOfWeekUTC(new Date());

    const { rows } = await this.pool.query(`SELECT COUNT(*) AS count FROM trades WHERE opened_at >= $1`, [weekStart]);
    const tradesThisWeek = Number(rows[0].count);

    return { allowed: tradesThisWeek < limit, tradesThisWeek, limit };
  }
}

module.exports = { TradeLimiter, startOfWeekUTC, SETTINGS_KEY, DEFAULT_LIMIT };
