/**
 * executionRouter.js
 * -----------------------------------------------------------------------
 * Dispatches a signal to every configured venue adapter in parallel via
 * Promise.allSettled, so one venue failing (bad API key, insufficient
 * balance, network hiccup) never blocks the others from executing. Also
 * tracks per-venue order/SL ids internally so TP1/TP2/SL-move/close
 * calls know what to act on later.
 * -----------------------------------------------------------------------
 */

const { computePositionSize } = require('./riskSizing');

/**
 * @typedef {Object} VenueResult
 * @property {boolean} success
 * @property {string} [orderId]
 * @property {number} [fillPrice]
 * @property {number} [size]
 * @property {string} [error]
 */

class ExecutionRouter {
  /**
   * @param {Record<string, import('./adapterInterface')>} adapters - keyed by venue name
   * @param {{ mode?: 'per_venue'|'total_portfolio', riskPct?: number }} riskOpts - fallback defaults
   * @param {import('../core/settingsStore').SettingsStore} [settingsStore] - if provided, live
   *   risk settings (set via Telegram's /setrisk) take precedence over riskOpts on each entry
   */
  constructor(adapters, riskOpts = {}, settingsStore) {
    this.adapters = adapters;
    this.riskOpts = riskOpts;
    this.settingsStore = settingsStore;
    // symbol -> venueName -> { orderId, slOrderId, side, size }
    this._openPositions = new Map();
  }

  /** Resolves the risk settings to actually use for the next entry — live
   *  settings from Telegram's /setrisk win over the constructor defaults. */
  async _resolveRiskOpts() {
    if (!this.settingsStore) return this.riskOpts;
    const riskPct = await this.settingsStore.get('riskPct', this.riskOpts.riskPct);
    const mode = await this.settingsStore.get('riskMode', this.riskOpts.mode ?? 'per_venue');
    return { riskPct, mode };
  }

  /**
   * Mirror an entry across every venue. Each venue sizes independently
   * based on its own balance (fixed-fractional risk sizing — see
   * riskSizing.js for the per-venue vs total-portfolio distinction).
   *
   * @param {string} symbol
   * @param {'bullish'|'bearish'} direction
   * @param {{ entry: number, sl: number, tp1: number, tp2: number, tpFull: number }} fib
   * @param {number} [referencePrice] - real market price to size against (last
   *   closed candle's close). Falls back to fib.entry only if omitted, which
   *   should only happen from older/test call sites.
   * @returns {Promise<Record<string, VenueResult>>}
   */
  async mirrorEntry(symbol, direction, fib, referencePrice) {
    const entryPriceForSizing = referencePrice ?? fib.entry;
    const side = direction === 'bullish' ? 'buy' : 'sell';
    const closingSide = side === 'buy' ? 'sell' : 'buy';
    const venueNames = Object.keys(this.adapters);
    const riskOpts = await this._resolveRiskOpts();

    const settled = await Promise.allSettled(
      venueNames.map(async (venueName) => {
        const adapter = this.adapters[venueName];
        const balance = await adapter.getBalance();
        const maxLeverage = typeof adapter.prepareLeverage === 'function' ? await adapter.prepareLeverage(symbol, entryPriceForSizing, fib.sl) : undefined;
        const { size } = computePositionSize({
          balance,
          entryPrice: entryPriceForSizing,
          slPrice: fib.sl,
          venueCount: venueNames.length,
          maxLeverage,
          ...riskOpts,
        });

        const { orderId, fillPrice } = await adapter.placeMarketOrder(symbol, side, size);
        let slOrderId;
        try { ({ orderId: slOrderId } = await adapter.placeStopLoss(symbol, closingSide, size, fib.sl)); }
        catch (slErr) {
          try { await adapter.closePercentage(symbol, closingSide, 100); } catch (_) { /* best effort */ }
          throw new Error('Stop-loss placement failed, entry closed for safety: ' + slErr.message);
        }

        this._trackPosition(symbol, venueName, { orderId, slOrderId, side, size });

        return { venueName, orderId, fillPrice, size };
      })
    );

    return this._collectResults(venueNames, settled);
  }

  /**
   * Mirror a partial close (TP1/TP2) across every venue that has an open
   * position for this symbol.
   *
   * @param {string} symbol
   * @param {'bullish'|'bearish'} direction
   * @param {number} pct - 0-100
   */
  async mirrorClosePercentage(symbol, direction, pct) {
    const closingSide = direction === 'bullish' ? 'sell' : 'buy';
    const venueNames = this._venuesWithPosition(symbol);

    const settled = await Promise.allSettled(
      venueNames.map(async (venueName) => {
        const adapter = this.adapters[venueName];
        const { orderId, closedSize } = await adapter.closePercentage(symbol, closingSide, pct);
        return { venueName, orderId, closedSize };
      })
    );

    return this._collectResults(venueNames, settled);
  }

  /**
   * Mirror moving SL to a new price (used for SL-to-breakeven after TP1)
   * across every venue with an open position.
   */
  async mirrorMoveStopLoss(symbol, newPrice) {
    const venueNames = this._venuesWithPosition(symbol);

    const settled = await Promise.allSettled(
      venueNames.map(async (venueName) => {
        const adapter = this.adapters[venueName];
        const tracked = this._openPositions.get(symbol)?.get(venueName);
        await adapter.moveStopLoss(symbol, tracked?.slOrderId, newPrice);
        return { venueName };
      })
    );

    return this._collectResults(venueNames, settled);
  }

  _trackPosition(symbol, venueName, data) {
    if (!this._openPositions.has(symbol)) this._openPositions.set(symbol, new Map());
    this._openPositions.get(symbol).set(venueName, data);
  }

  _venuesWithPosition(symbol) {
    const tracked = this._openPositions.get(symbol);
    return tracked ? Array.from(tracked.keys()) : [];
  }

  _collectResults(venueNames, settled) {
    /** @type {Record<string, VenueResult>} */
    const results = {};
    settled.forEach((outcome, i) => {
      const venueName = venueNames[i];
      if (outcome.status === 'fulfilled') {
        results[venueName] = { success: true, ...outcome.value };
      } else {
        results[venueName] = { success: false, error: outcome.reason?.message ?? String(outcome.reason) };
      }
    });
    return results;
  }
}

module.exports = { ExecutionRouter };
