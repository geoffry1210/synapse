/**
 * mt5Adapter.js
 * -----------------------------------------------------------------------
 * Implements the ExchangeAdapter interface for an MT5 prop account via
 * MetaApi.cloud — a cloud service that exposes a REST/WebSocket API to a
 * real MT5 terminal, so you don't have to run MT5 itself on Railway.
 *
 * ⚠️ CAVEAT: unlike the ccxt adapter (verified against the installed
 * package directly), the MetaApi SDK surface below is based on their
 * documented usage patterns and hasn't been verified against a live
 * MetaApi account in this environment — the SDK's exact method names
 * can shift between versions. Before relying on this, run it against a
 * MetaApi demo account and check the current SDK docs
 * (https://metaapi.cloud/docs/client/) for the connection/order methods
 * on whatever `metaapi.cloud-sdk` version you install.
 * -----------------------------------------------------------------------
 */

const MetaApi = require('metaapi.cloud-sdk').default;

class Mt5Adapter {
  /**
   * @param {string} token - MetaApi API token
   * @param {string} accountId - your MetaApi account id (links to the MT5 login)
   */
  constructor(token, accountId) {
    this.venueName = 'mt5';
    this.api = new MetaApi(token);
    this.accountId = accountId;
    this.connection = null;
  }

  /** Must be called once before any other method. */
  async connect() {
    const account = await this.api.metatraderAccountApi.getAccount(this.accountId);
    await account.waitDeployed();

    this.connection = account.getRPCConnection();
    await this.connection.connect();
    await this.connection.waitSynchronized();
  }

  async getBalance() {
    const accountInfo = await this.connection.getAccountInformation();
    return accountInfo.balance;
  }

  async placeMarketOrder(symbol, side, size) {
    const order =
      side === 'buy'
        ? await this.connection.createMarketBuyOrder(symbol, size)
        : await this.connection.createMarketSellOrder(symbol, size);
    return { orderId: order.orderId, fillPrice: order.openPrice };
  }

  /**
   * MT5 typically attaches SL directly on the position rather than as a
   * separate order — use modifyPosition to set/move it. This method
   * exists to satisfy the shared interface, but for MT5 the SL is set at
   * order-open time or moved via `moveStopLoss` below.
   */
  async placeStopLoss(symbol, side, size, slPrice) {
    const position = await this.getPosition(symbol);
    if (!position) throw new Error(`Mt5Adapter: no open position for ${symbol} to attach SL to`);
    await this.connection.modifyPosition(position.id, slPrice);
    return { orderId: position.id };
  }

  async closePercentage(symbol, side, pct) {
    const position = await this.getPosition(symbol);
    if (!position) throw new Error(`Mt5Adapter: no open position for ${symbol}`);

    const closeVolume = position.size * (pct / 100);
    const result = await this.connection.closePositionPartially(position.id, closeVolume);
    return { orderId: result.orderId, closedSize: closeVolume };
  }

  async moveStopLoss(symbol, orderId, newPrice) {
    // orderId here is actually the MT5 position id (see placeStopLoss).
    await this.connection.modifyPosition(orderId, newPrice);
  }

  async getPosition(symbol) {
    const positions = await this.connection.getPositions();
    const pos = positions.find((p) => p.symbol === symbol);
    if (!pos) return null;
    return { size: pos.volume, entryPrice: pos.openPrice, side: pos.type === 'POSITION_TYPE_BUY' ? 'buy' : 'sell', id: pos.id };
  }
}

module.exports = { Mt5Adapter };
