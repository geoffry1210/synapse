/**
 * gridBot.js
 * -----------------------------------------------------------------------
 * A neutral futures grid: N price levels between lowerBound and
 * upperBound, geometrically spaced (percentage-based — standard for
 * crypto, where price moves are better modeled multiplicatively than
 * additively). Each adjacent pair of levels is a "cell": the cell below
 * current price starts with a resting BUY (open-long) at its lower
 * edge; a cell above starts with a resting SELL (open-short) at its
 * upper edge. When an opening order fills, its paired closing order —
 * one grid step better, reduceOnly — is placed immediately. When THAT
 * fills, a new opening order goes back to re-arm the same cell at the
 * SAME side it started from, so the grid keeps cycling on its own as
 * price oscillates, instead of firing once and going idle.
 *
 * Panic stop: if price closes beyond [lowerBound*(1-stopBufferPct),
 * upperBound*(1+stopBufferPct)], every resting order is canceled and
 * every open grid position is closed, and the grid halts (does not
 * auto-restart). A strong, sustained trend is exactly the condition a
 * neutral grid loses money in — repeatedly buying into a fall or
 * selling into a rally with no edge — so this bounds the damage instead
 * of continuing to re-arm into it. Closes use an aggressively-priced
 * reduceOnly limit order (crosses the book immediately) rather than a
 * plain market order, specifically so panic-close never touches
 * placeMarketOrder/getPosition's shared aggregate-position state on the
 * adapter — a grid runs many independent positions per symbol at once,
 * and another strategy (the SMC engine, dump-shorts) could be live on
 * the SAME adapter instance for a DIFFERENT symbol; this keeps grid
 * order flow fully isolated from that regardless.
 *
 * Self-contained bookkeeping throughout: never calls the adapter's
 * getPosition()/closePercentage() (those assume one position per
 * symbol) — only placeLimitOrder/cancelOrder/pollFilledOrders/
 * getOpenOrders, which every adapter now implements (see
 * dryRunAdapter.js / ccxtAdapter.js).
 * -----------------------------------------------------------------------
 */

class GridBot {
  /**
   * @param {string} symbol
   * @param {{
   *   lowerBound: number,
   *   upperBound: number,
   *   levels: number,          // number of grid price POINTS (levels-1 cells)
   *   capitalPerLevel: number, // USD notional per opening order
   *   stopBufferPct?: number,  // panic-stop distance beyond bounds, fraction (default 0.1 = 10%)
   * }} opts
   */
  constructor(symbol, opts) {
    this.symbol = symbol;
    this.lowerBound = opts.lowerBound;
    this.upperBound = opts.upperBound;
    this.levels = opts.levels;
    this.capitalPerLevel = opts.capitalPerLevel;
    this.stopBufferPct = opts.stopBufferPct ?? 0.1;

    if (!(this.lowerBound > 0) || !(this.upperBound > this.lowerBound)) {
      throw new Error('GridBot: upperBound must be greater than lowerBound, both > 0');
    }
    if (!Number.isInteger(this.levels) || this.levels < 2) {
      throw new Error('GridBot: levels must be an integer >= 2');
    }
    if (!(this.capitalPerLevel > 0)) {
      throw new Error('GridBot: capitalPerLevel must be > 0');
    }

    this.prices = [];
    const ratio = Math.pow(this.upperBound / this.lowerBound, 1 / (this.levels - 1));
    for (let i = 0; i < this.levels; i++) this.prices.push(this.lowerBound * Math.pow(ratio, i));

    // One cell per adjacent price pair.
    this.cells = [];
    for (let i = 0; i < this.prices.length - 1; i++) {
      this.cells.push({
        lower: this.prices[i],
        upper: this.prices[i + 1],
        state: 'uninitialized', // uninitialized | buy_open_resting | long_open | sell_open_resting | short_open | halted
        openOrderId: null,
        closeOrderId: null,
        entryPrice: null,
        entryDirection: null, // 'buy' | 'sell' — the direction of the currently-open position, if any
        entrySize: null,
      });
    }

    this.halted = false;
    this.haltReason = null;
    this.realizedPnl = 0;
    this.fillCount = 0;
  }

  /** Places the initial resting orders for every cell that fully sits above or below currentPrice. */
  async initialize(adapter, currentPrice) {
    await this._armUninitializedCells(adapter, currentPrice);
  }

  async _armUninitializedCells(adapter, currentPrice) {
    for (const cell of this.cells) {
      if (cell.state !== 'uninitialized') continue;
      // A cell entirely BELOW current price needs price to DROP into it —
      // arm a BUY at its lower edge (buy the dip, expecting a bounce).
      // A cell entirely ABOVE current price needs price to RISE into it —
      // arm a SELL at its upper edge (sell the rally, expecting a pullback).
      if (cell.upper <= currentPrice) await this._armBuy(adapter, cell);
      else if (cell.lower >= currentPrice) await this._armSell(adapter, cell);
      // else: straddles current price — left uninitialized until a future tick's price has moved past one edge.
    }
  }

  async _armBuy(adapter, cell) {
    try {
      const size = this.capitalPerLevel / cell.lower;
      const { orderId } = await adapter.placeLimitOrder(this.symbol, 'buy', size, cell.lower);
      cell.state = 'buy_open_resting';
      cell.openOrderId = orderId;
    } catch (e) {
      console.warn(`[grid] ${this.symbol}: failed to arm buy at ${cell.lower}, will retry next tick: ${e.message}`);
    }
  }

  async _armSell(adapter, cell) {
    try {
      const size = this.capitalPerLevel / cell.upper;
      const { orderId } = await adapter.placeLimitOrder(this.symbol, 'sell', size, cell.upper);
      cell.state = 'sell_open_resting';
      cell.openOrderId = orderId;
    } catch (e) {
      console.warn(`[grid] ${this.symbol}: failed to arm sell at ${cell.upper}, will retry next tick: ${e.message}`);
    }
  }

  /**
   * One tick: arms any still-uninitialized cells price has now moved
   * past, checks for panic-stop, then checks for fills and reacts —
   * places the paired closing order for a newly-opened position, or
   * re-arms the cell (same side it started from) after its closing
   * order fills.
   *
   * @returns {Promise<{ halted: boolean, reason?: string, events?: object[] }>}
   */
  async tick(adapter, currentPrice) {
    if (this.halted) return { halted: true, reason: this.haltReason };

    await this._armUninitializedCells(adapter, currentPrice);

    const panicLow = this.lowerBound * (1 - this.stopBufferPct);
    const panicHigh = this.upperBound * (1 + this.stopBufferPct);
    if (currentPrice <= panicLow || currentPrice >= panicHigh) {
      await this._panicStop(adapter, currentPrice, panicLow, panicHigh);
      return { halted: true, reason: this.haltReason };
    }

    const fills = await adapter.pollFilledOrders(this.symbol);
    const events = [];
    for (const fill of fills) {
      const cell = this.cells.find((c) => c.openOrderId === fill.orderId || c.closeOrderId === fill.orderId);
      if (!cell) continue; // not one of ours — shouldn't happen, but never crash the tick over it

      if (fill.orderId === cell.openOrderId) {
        // Opening order filled -> place its paired closing order, one grid step better.
        cell.entryPrice = fill.price;
        cell.entryDirection = fill.side;
        cell.entrySize = fill.size;
        cell.openOrderId = null;
        this.fillCount++;
        if (fill.side === 'buy') {
          const { orderId } = await adapter.placeLimitOrder(this.symbol, 'sell', fill.size, cell.upper, {
            reduceOnly: true, entryPrice: fill.price, entryDirection: 'buy',
          });
          cell.state = 'long_open';
          cell.closeOrderId = orderId;
        } else {
          const { orderId } = await adapter.placeLimitOrder(this.symbol, 'buy', fill.size, cell.lower, {
            reduceOnly: true, entryPrice: fill.price, entryDirection: 'sell',
          });
          cell.state = 'short_open';
          cell.closeOrderId = orderId;
        }
        events.push({ type: 'opened', lower: cell.lower, upper: cell.upper, side: fill.side, price: fill.price, size: fill.size });
      } else {
        // Closing order filled -> realize pnl, re-arm the cell at the same side it started from.
        this.realizedPnl += fill.pnl ?? 0;
        this.fillCount++;
        events.push({ type: 'closed', lower: cell.lower, upper: cell.upper, side: fill.side, price: fill.price, size: fill.size, pnl: fill.pnl });
        cell.closeOrderId = null;
        cell.entryPrice = null;
        cell.entryDirection = null;
        cell.entrySize = null;
        // A long closes via a sell fill -> re-arm as a buy; a short closes via a buy fill -> re-arm as a sell.
        if (fill.side === 'sell') await this._armBuy(adapter, cell);
        else await this._armSell(adapter, cell);
      }
    }

    return { halted: false, events };
  }

  async _panicStop(adapter, currentPrice, panicLow, panicHigh) {
    this.haltReason = `price ${currentPrice} breached panic bounds [${panicLow}, ${panicHigh}]`;
    for (const cell of this.cells) {
      if (cell.openOrderId) {
        try { await adapter.cancelOrder(this.symbol, cell.openOrderId); } catch { /* already gone */ }
        cell.openOrderId = null;
      }
      if (cell.closeOrderId && cell.entryDirection && cell.entryPrice !== null) {
        try { await adapter.cancelOrder(this.symbol, cell.closeOrderId); } catch { /* already gone */ }
        const closingSide = cell.entryDirection === 'buy' ? 'sell' : 'buy';
        // Aggressively priced so it crosses the book immediately — the
        // reduceOnly-limit equivalent of a market close, chosen
        // specifically to avoid placeMarketOrder (see this file's header).
        const aggressivePrice = closingSide === 'sell' ? currentPrice * 0.9 : currentPrice * 1.1;
        try {
          await adapter.placeLimitOrder(this.symbol, closingSide, cell.entrySize, aggressivePrice, {
            reduceOnly: true, entryPrice: cell.entryPrice, entryDirection: cell.entryDirection,
          });
        } catch (e) {
          console.error(`[grid] ${this.symbol}: panic-close order failed for cell [${cell.lower}, ${cell.upper}]: ${e.message}`);
        }
        cell.closeOrderId = null;
        cell.entryPrice = null;
        cell.entryDirection = null;
        cell.entrySize = null;
      }
      cell.state = 'halted';
    }
    // Confirm the panic-close fills right away and fold their PnL in. On
    // DryRunAdapter these cross immediately (same price point); on a
    // real exchange an aggressively-priced order fills almost instantly
    // too but isn't guaranteed caught in this exact call — the position
    // is genuinely closed either way, this only means realizedPnl might
    // catch up one tick late in that specific case.
    try {
      const confirmed = await adapter.pollFilledOrders(this.symbol);
      for (const fill of confirmed) this.realizedPnl += fill.pnl ?? 0;
    } catch (e) {
      console.warn(`[grid] ${this.symbol}: could not confirm panic-close fills immediately: ${e.message}`);
    }
    this.halted = true;
  }

  /** @returns {{ openPositions: number, restingOrders: number, realizedPnl: number, fillCount: number, halted: boolean }} */
  getStatus() {
    const openPositions = this.cells.filter((c) => c.state === 'long_open' || c.state === 'short_open').length;
    const restingOrders = this.cells.filter((c) => c.state === 'buy_open_resting' || c.state === 'sell_open_resting').length
      + this.cells.filter((c) => c.closeOrderId).length;
    return { openPositions, restingOrders, realizedPnl: this.realizedPnl, fillCount: this.fillCount, halted: this.halted };
  }
}

module.exports = { GridBot };
