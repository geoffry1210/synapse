/**
 * settingsStore.js
 * -----------------------------------------------------------------------
 * Thin key/value wrapper over the bot_settings table. Used for
 * runtime-configurable values you set via Telegram (e.g. weekly trade
 * limit) that need to survive a restart — unlike in-memory state, which
 * would silently reset.
 * -----------------------------------------------------------------------
 */

class SettingsStore {
  /**
   * @param {{ query: (sql: string, params?: any[]) => Promise<any> }} pool
   */
  constructor(pool) {
    this.pool = pool;
  }

  /**
   * @param {string} key
   * @param {*} defaultValue - returned if the key isn't set yet
   */
  async get(key, defaultValue = null) {
    const { rows } = await this.pool.query(`SELECT value FROM bot_settings WHERE key = $1`, [key]);
    return rows.length > 0 ? rows[0].value : defaultValue;
  }

  /**
   * @param {string} key
   * @param {*} value - anything JSON-serializable
   */
  async set(key, value) {
    await this.pool.query(
      `INSERT INTO bot_settings (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`,
      [key, JSON.stringify(value)]
    );
  }
}

module.exports = { SettingsStore };
