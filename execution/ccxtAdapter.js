/**
 * ccxtAdapter.js
 * -----------------------------------------------------------------------
 * Implements the ExchangeAdapter interface (see adapterInterface.js)
 * using ccxt, which gives Bybit, MEXC, and Bitget a unified API — so one
 * class covers all three, parameterized by exchange id.
 *
 * NOTE: this has NOT been tested against live exchange endpoints — this
 * sandbox can't reach exchange API domains. The ccxt calls below follow
 * ccxt's standard unified-API method names (createOrder, fetchBalance,
 * fetchPosition), which are stable across exchanges by design, but you
 * should test against your exchange's testnet before going live with a
 * real account.
 * -----------------------------------------------------------------------
 */

const ccxt = require('ccxt');

class CcxtAdapter {
  /**
   * @param {'bybit'|'mexc'|'bitget'} exchangeId
   * @param {{ apiKey: string, secret: string, password?: string, sandbox?: boolean }} credentials
   *   `password` is required by some exchanges (e.g. Bitget's API passphrase).
   *   Never hardcode credentials — load from environment variables.
   */
  constructor(exchangeId, credentials) {
    const ExchangeClass = ccxt[exchangeId];
    if (!ExchangeClass) throw new Error(`ccxt has no exchange named "${exchangeId}"`);

    this.venueName = exchangeId;
    this.exchange = new ExchangeClass({
      apiKey: credentials.apiKey,
      secret: credentials.secret,
      password: credentials.password,
      enableRateLimit: true,
    });

    if (credentials.sandbox) {
      this.exchange.setSandboxMode(true);
    }
  }

  async getBalance() {
    const balance = await this.exchange.fetchBalance();
    return balance.free?.USDT ?? 0;
  }

  async placeMarketOrder(symbol, side, size) {
    const order = await this.exchange.createOrder(symbol, 'market', side, size);
    return { orderId: order.id, fillPrice: order.average ?? order.price };
  }

  async placeStopLoss(symbol, side, size, slPrice) {
    // ccxt's unified params for stop orders vary slightly by exchange;
    // 'stopPrice' is the most broadly supported unified param name.
    const order = await this.exchange.createOrder(symbol, 'market', side, size, undefined, {
      stopPrice: slPrice,
      reduceOnly: true,
    });
    return { orderId: order.id };
  }

  async closePercentage(symbol, side, pct) {
    const position = await this.getPosition(symbol);
    if (!position) throw new Error(`CcxtAdapter(${this.venueName}): no open position for ${symbol}`);

    const closeSize = position.size * (pct / 100);
    const order = await this.exchange.createOrder(symbol, 'market', side, closeSize, undefined, {
      reduceOnly: true,
    });
    return { orderId: order.id, closedSize: closeSize };
  }

  async moveStopLoss(symbol, orderId, newPrice) {
    // Most exchanges require cancel + recreate rather than an in-place
    // edit for stop orders.
    await this.exchange.cancelOrder(orderId, symbol);
    // Caller is expected to track side/size and call placeStopLoss again
    // with the new price — kept explicit rather than guessed here.
  }

  async getPosition(symbol) {
    const positions = await this.exchange.fetchPositions([symbol]);
    const pos = positions.find((p) => p.symbol === symbol && p.contracts > 0);
    if (!pos) return null;
    return { size: pos.contracts, entryPrice: pos.entryPrice, side: pos.side };
  }
}

module.exports = { CcxtAdapter };
