/**
 * journal.js
 * -----------------------------------------------------------------------
 * Writes SetupManager's event log to Postgres, matching the schema in
 * schema.sql. Designed for dependency injection so it's testable without
 * a real database: pass anything with an async `.query(sql, params)`
 * method (a `pg.Pool`, a `pg.Client`, or a mock/spy for tests).
 *
 * Two ways to use it:
 *  1. Low-level methods (createSetup, logConfluenceFlag, createTrade,
 *     logTradeEvent, ...) — call these directly as things happen.
 *  2. `syncLog(setupManager, symbol, venue)` — feeds SetupManager's flat
 *     `.log` array through automatically, tracking setup/trade IDs so
 *     you don't have to wire every call site by hand. Call this once per
 *     candle (or on flush) after driving the SetupManager forward.
 * -----------------------------------------------------------------------
 */

class Journal {
  /**
   * @param {{ query: (sql: string, params?: any[]) => Promise<any> }} pool
   */
  constructor(pool) {
    this.pool = pool;
    // Per-symbol bookkeeping so syncLog() knows which DB row a given
    // in-memory setup/trade log entry corresponds to.
    this._currentSetupId = new Map(); // symbol -> setup.id
    this._currentTradeId = new Map(); // symbol -> trade.id
    this._processedLogLength = new Map(); // symbol -> how much of .log we've synced
  }

  async createSetup(symbol, venue, setup) {
    const { rows } = await this.pool.query(
      `INSERT INTO setups
        (symbol, venue, direction, ob_low, ob_high, fib_entry, fib_sl, fib_tp1, fib_tp2, fib_tp_full, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'OB_IDENTIFIED')
       RETURNING id`,
      [
        symbol,
        venue,
        setup.direction,
        setup.ob.low,
        setup.ob.high,
        setup.fib.entry,
        setup.fib.sl,
        setup.fib.tp1,
        setup.fib.tp2,
        setup.fib.tpFull,
      ]
    );
    return rows[0].id;
  }

  async updateSetupStatus(setupId, status, closeReason = null) {
    const closedAt = ['CLOSED', 'CANCELLED'].includes(status) ? 'now()' : 'NULL';
    await this.pool.query(
      `UPDATE setups SET status = $1, close_reason = $2, closed_at = ${closedAt} WHERE id = $3`,
      [status, closeReason, setupId]
    );
  }

  async logConfluenceFlag(setupId, bucket, flagName) {
    await this.pool.query(
      `INSERT INTO confluence_log (setup_id, bucket, flag_name) VALUES ($1,$2,$3)`,
      [setupId, bucket, flagName]
    );
  }

  async createTrade(setupId, symbol, venue, direction, trade) {
    const { rows } = await this.pool.query(
      `INSERT INTO trades
        (setup_id, symbol, venue, direction, entry_price, size, remaining_size, sl, tp1, tp2, tp_full)
       VALUES ($1,$2,$3,$4,$5,$6,$6,$7,$8,$9,$10)
       RETURNING id`,
      [setupId, symbol, venue, direction, trade.entryPrice, trade.size, trade.sl, trade.tp1 ?? 0, trade.tp2 ?? 0, trade.tpFull ?? 0]
    );
    return rows[0].id;
  }

  async logTradeEvent(tradeId, eventType, data = {}) {
    await this.pool.query(
      `INSERT INTO trade_events (trade_id, event_type, data) VALUES ($1,$2,$3)`,
      [tradeId, eventType, JSON.stringify(data)]
    );

    if (eventType === 'tp1_hit') {
      await this.pool.query(`UPDATE trades SET tp1_hit = true, sl_moved_to_entry = true WHERE id = $1`, [tradeId]);
    } else if (eventType === 'tp2_hit') {
      await this.pool.query(`UPDATE trades SET tp2_hit = true WHERE id = $1`, [tradeId]);
    } else if (eventType === 'full_close' || eventType === 'sl_hit') {
      await this.pool.query(
        `UPDATE trades SET status = 'CLOSED', closed_at = now(), pnl = $2 WHERE id = $1`,
        [tradeId, data.pnl ?? null]
      );
    }
  }

  /**
   * Drain any new entries from a SetupManager's in-memory log and persist
   * them, tracking which DB row each in-memory setup/trade currently maps
   * to. Safe to call repeatedly — only processes entries added since the
   * last call for this symbol.
   *
   * @param {import('../core/setupManager').SetupManager} setupManager
   * @param {string} venue
   */
  async syncLog(setupManager, venue) {
    const symbol = setupManager.symbol;
    const startFrom = this._processedLogLength.get(symbol) ?? 0;
    const newEntries = setupManager.log.slice(startFrom);

    for (const entry of newEntries) {
      await this._applyLogEntry(symbol, venue, entry);
    }

    this._processedLogLength.set(symbol, setupManager.log.length);
  }

  async _applyLogEntry(symbol, venue, entry) {
    switch (entry.type) {
      case 'setup_created': {
        // Reconstruct enough of a "setup" shape for createSetup(); the
        // log entry carries direction/obRange/fib already.
        const pseudoSetup = {
          direction: entry.direction,
          ob: { low: entry.obRange[0], high: entry.obRange[1] },
          fib: entry.fib,
        };
        const id = await this.createSetup(symbol, venue, pseudoSetup);
        this._currentSetupId.set(symbol, id);
        break;
      }

      case 'setup_cancelled': {
        const setupId = this._currentSetupId.get(symbol);
        if (setupId) await this.updateSetupStatus(setupId, 'CANCELLED', entry.reason);
        break;
      }

      case 'entered_zone': {
        const setupId = this._currentSetupId.get(symbol);
        if (setupId) await this.updateSetupStatus(setupId, 'IN_ZONE_AWAITING_CONFLUENCE');
        break;
      }

      case 'confluence_flag': {
        const setupId = this._currentSetupId.get(symbol);
        if (setupId) await this.logConfluenceFlag(setupId, entry.bucket, entry.flagName);
        break;
      }

      case 'trade_entered': {
        const setupId = this._currentSetupId.get(symbol);
        if (setupId) await this.updateSetupStatus(setupId, 'IN_TRADE');
        const tradeId = await this.createTrade(setupId, symbol, venue, entry.direction, {
          entryPrice: entry.entryPrice,
          size: entry.size,
          sl: entry.fib.sl,
          tp1: entry.fib.tp1,
          tp2: entry.fib.tp2,
          tpFull: entry.fib.tpFull,
        });
        this._currentTradeId.set(symbol, tradeId);
        await this.logTradeEvent(tradeId, 'entry', { entryPrice: entry.entryPrice, size: entry.size });
        break;
      }

      case 'tp1_hit':
      case 'tp2_hit': {
        const tradeId = this._currentTradeId.get(symbol);
        if (tradeId) await this.logTradeEvent(tradeId, entry.type, entry);
        break;
      }

      case 'full_close':
      case 'sl_hit': {
        const tradeId = this._currentTradeId.get(symbol);
        if (tradeId) await this.logTradeEvent(tradeId, entry.type, entry);
        const setupId = this._currentSetupId.get(symbol);
        if (setupId) await this.updateSetupStatus(setupId, 'CLOSED', entry.type);
        break;
      }

      case 'trade_closed': {
        const setupId = this._currentSetupId.get(symbol);
        if (setupId) await this.updateSetupStatus(setupId, 'CLOSED', entry.reason);
        const tradeId = this._currentTradeId.get(symbol);
        if (tradeId) await this.logTradeEvent(tradeId, 'full_close', { reason: entry.reason });
        break;
      }

      default:
        // 'ob_not_found' and any future event types with nothing to
        // persist are safely ignored.
        break;
    }
  }
}

module.exports = { Journal };
