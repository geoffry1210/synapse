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
}

module.exports = { DryRunAdapter };
