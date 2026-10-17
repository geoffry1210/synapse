/**
 * dryRunAdapter.js
 * -----------------------------------------------------------------------
 * Simulates an exchange entirely in memory: fills orders instantly at
 * the price you tell it, tracks a fake balance and position. Implements
 * the same interface as every real adapter (see adapterInterface.js), so
 * it's a drop-in replacement for:
 *
 *   1. Testing the execution router without hitting real APIs (used in
 *      demo-execution.js).
 *   2. PAPER TRADING — running the full engine live against real market
 *      data feeds, but routing orders here instead of a real venue, so
 *      you can validate the whole system with zero financial risk before
 *      switching any venue over to a real adapter.
 * -----------------------------------------------------------------------
 */

class DryRunAdapter {
  /**
   * @param {string} venueName - label only, e.g. "bybit-dryrun"
   * @param {number} startingBalance
   */
  constructor(venueName, startingBalance = 10000) {
    this.venueName = venueName;
    this.balance = startingBalance;
    this.positions = new Map(); // symbol -> { size, entryPrice, side }
    this.orders = [];
    this._orderSeq = 1;
    this._simulatedPrice = new Map(); // symbol -> current price, settable by tests
    this._restingLimitOrders = new Map(); // symbol -> [{ orderId, side, size, price, reduceOnly, entryPrice? }]
  }

  /** Tests/demos call this to control what price the "market" is at. */
  setPrice(symbol, price) {
    this._simulatedPrice.set(symbol, price);
  }

  async getBalance() {
    return this.balance;
  }

  async placeMarketOrder(symbol, side, size) {
    const fillPrice = this._simulatedPrice.get(symbol);
    if (fillPrice === undefined) {
      throw new Error(`DryRunAdapter: no simulated price set for ${symbol} — call setPrice() first`);
    }

    this.positions.set(symbol, { size, entryPrice: fillPrice, side });
    const orderId = `dry-${this._orderSeq++}`;
    this.orders.push({ orderId, type: 'market', symbol, side, size, fillPrice });
    return { orderId, fillPrice };
  }

  async placeStopLoss(symbol, side, size, slPrice) {
    const orderId = `dry-sl-${this._orderSeq++}`;
    this.orders.push({ orderId, type: 'stop_loss', symbol, side, size, slPrice });
    return { orderId };
  }

  async closePercentage(symbol, side, pct) {
    const position = this.positions.get(symbol);
    if (!position) throw new Error(`DryRunAdapter: no open position for ${symbol}`);

    const closedSize = position.size * (pct / 100);
    const fillPrice = this._simulatedPrice.get(symbol) ?? position.entryPrice;

    // Simplified PnL: (fillPrice - entryPrice) * closedSize, sign-flipped for shorts.
    const direction = position.side === 'buy' ? 1 : -1;
    const pnl = (fillPrice - position.entryPrice) * closedSize * direction;
    this.balance += pnl;

    position.size -= closedSize;
    if (position.size <= 1e-9) this.positions.delete(symbol);

    const orderId = `dry-close-${this._orderSeq++}`;
    this.orders.push({ orderId, type: 'close', symbol, side, closedSize, fillPrice, pnl });
    return { orderId, closedSize, pnl };
  }

  async moveStopLoss(symbol, orderId, newPrice) {
    const order = this.orders.find((o) => o.orderId === orderId);
    if (order) order.slPrice = newPrice;
  }

  async getPosition(symbol) {
    return this.positions.get(symbol) ?? null;
  }

  // --- Limit-order simulation, for the grid bot (core/gridBot.js) ---
  // Grid trading manages many small, independent positions per symbol at
  // once, not one aggregate position — these methods intentionally never
  // touch this.positions, the single-aggregate-position map the SMC/
  // dump-short paths use via placeMarketOrder/closePercentage above.

  /**
   * Places a resting limit order. Doesn't fill immediately — call
   * pollFilledOrders() to check whether it's crossed yet.
   *
   * @param {string} symbol
   * @param {'buy'|'sell'} side
   * @param {number} size
   * @param {number} price
   * @param {{ reduceOnly?: boolean, entryPrice?: number, entryDirection?: 'buy'|'sell' }} [opts]
   *   reduceOnly: true for a closing order — entryPrice/entryDirection
   *   (the position this order closes) are required in that case so PnL
   *   can be computed on fill. DryRunAdapter has no aggregate-position
   *   concept for grid orders to look this up from, so the caller (the
   *   grid bot) must supply it, same as it already tracks for itself.
   * @returns {Promise<{ orderId: string }>}
   */
  async placeLimitOrder(symbol, side, size, price, opts = {}) {
    if (opts.reduceOnly && (opts.entryPrice === undefined || !opts.entryDirection)) {
      throw new Error('DryRunAdapter.placeLimitOrder: reduceOnly orders need entryPrice and entryDirection to compute PnL on fill');
    }
    const orderId = `dry-limit-${this._orderSeq++}`;
    const order = {
      orderId, symbol, side, size, price,
      reduceOnly: !!opts.reduceOnly, entryPrice: opts.entryPrice, entryDirection: opts.entryDirection,
    };
    if (!this._restingLimitOrders.has(symbol)) this._restingLimitOrders.set(symbol, []);
    this._restingLimitOrders.get(symbol).push(order);
    return { orderId };
  }

  /** No-op if the order already filled or doesn't exist — same "already gone" tolerance as the real adapters. */
  async cancelOrder(symbol, orderId) {
    const resting = this._restingLimitOrders.get(symbol);
    if (!resting) return;
    const idx = resting.findIndex((o) => o.orderId === orderId);
    if (idx !== -1) resting.splice(idx, 1);
  }

  /**
   * Checks resting limit orders against the current simulated price and
   * "fills" any that have crossed — a buy limit fills at or below its
   * price, a sell limit fills at or above it. Filled orders are removed
   * from the resting set and returned with their fill details; a
   * reduceOnly fill also realizes PnL into this.balance (same sign
   * convention as closePercentage: (fillPrice-entryPrice)*size*direction).
   * Call once per tick; returns [] when nothing new filled.
   *
   * @param {string} symbol
   * @returns {Promise<{ orderId: string, side: 'buy'|'sell', size: number, price: number, reduceOnly: boolean, pnl?: number }[]>}
   */
  async pollFilledOrders(symbol) {
    const price = this._simulatedPrice.get(symbol);
    const resting = this._restingLimitOrders.get(symbol);
    if (price === undefined || !resting || resting.length === 0) return [];

    const filled = [];
    const stillResting = [];
    for (const order of resting) {
      const crossed = order.side === 'buy' ? price <= order.price : price >= order.price;
      if (!crossed) { stillResting.push(order); continue; }

      const result = { orderId: order.orderId, side: order.side, size: order.size, price: order.price, reduceOnly: order.reduceOnly };
      if (order.reduceOnly) {
        const direction = order.entryDirection === 'buy' ? 1 : -1;
        const pnl = (order.price - order.entryPrice) * order.size * direction;
        this.balance += pnl;
        result.pnl = pnl;
      }
      this.orders.push({ type: 'limit_fill', symbol, ...result });
      filled.push(result);
    }
    this._restingLimitOrders.set(symbol, stillResting);
    return filled;
  }

  /** @returns {Promise<{ orderId: string, side: 'buy'|'sell', size: number, price: number, reduceOnly: boolean }[]>} currently resting, unfilled limit orders */
  async getOpenOrders(symbol) {
    return (this._restingLimitOrders.get(symbol) ?? []).map(
      ({ orderId, side, size, price, reduceOnly }) => ({ orderId, side, size, price, reduceOnly })
    );
  }
}

module.exports = { DryRunAdapter };
