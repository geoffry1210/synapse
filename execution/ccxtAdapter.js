/**
 * ccxtAdapter.js  (Bybit demo-trading + linear perps + per-trade max leverage)
 * -----------------------------------------------------------------------
 *   - `demo: true`     -> Bybit Demo Trading (fake funds, real prices)
 *   - `market: 'swap'` -> USDT linear perps, so SHORTS work
 *   - marginMode (default 'cross', env BYBIT_MARGIN_MODE): cross margin means the whole
 *     account backs each position, so liquidation is far beyond any sane stop.
 *   - prepareLeverage(): before each entry picks the HIGHEST leverage that is
 *       (a) allowed for that symbol by the exchange (market.limits.leverage.max) and
 *       (b) no higher than optional `maxLeverageCap`.
 *     In ISOLATED mode it is also lowered until the stop triggers well before liquidation.
 *     Position SIZE is set by risk (riskSizing.js), so leverage only changes how much
 *     margin is locked, never how much you lose at the stop.
 *   - moveStopLoss places the new stop before cancelling the old one.
 * Not verified against live Bybit from this sandbox; run on Bybit DEMO first.
 * -----------------------------------------------------------------------
 */
const ccxt = require('ccxt');

const STOP_TO_LIQ_RATIO = 0.7; // stop must be within 70% of the distance to liquidation
const MAINT_MARGIN_AND_FEES = 0.01; // assume ~1% of price is eaten by maintenance margin + fees

class CcxtAdapter {
  constructor(exchangeId, credentials = {}) {
    this.venueName = exchangeId;
    this.swap = credentials.market === 'swap';
    this.maxLeverageCap = Number(credentials.maxLeverageCap) || Infinity;
    this.marginMode = credentials.marginMode ?? process.env.BYBIT_MARGIN_MODE ?? 'cross'; // 'cross' | 'isolated'
    this._modeSet = new Set();
    this._lev = new Map(); // ccxt symbol -> leverage used for the latest entry
    this._sl = new Map(); // ccxt symbol -> latest stop-loss order id
    this._gridOrders = new Map(); // ccxt symbol -> [{ orderId, side, size, price, reduceOnly, entryPrice?, entryDirection? }], for the grid bot

    if (credentials._exchange) {
      this.exchange = credentials._exchange;
    } else {
      const ExchangeClass = ccxt[exchangeId];
      if (!ExchangeClass) throw new Error(`ccxt has no exchange named "${exchangeId}"`);
      this.exchange = new ExchangeClass({
        apiKey: credentials.apiKey, secret: credentials.secret, password: credentials.password,
        enableRateLimit: true,
        options: this.swap ? { defaultType: 'swap', defaultSettle: 'USDT' } : {},
      });
    }
    if (credentials.demo) {
      if (typeof this.exchange.enableDemoTrading !== 'function') throw new Error('This ccxt version has no enableDemoTrading(). Run: npm install ccxt@latest');
      this.exchange.enableDemoTrading(true);
    }
    if (credentials.sandbox) this.exchange.setSandboxMode(true);
  }

  _sym(symbol) {
    if (!this.swap || symbol.includes(':')) return symbol;
    const base = symbol.includes('/') ? symbol.split('/')[0] : symbol.replace(/USDT$/, '');
    return `${base}/USDT:USDT`;
  }
  async _prep(symbol) { const sym = this._sym(symbol); await this.exchange.loadMarkets(); return sym; }
  _amt(sym, size) {
    const a = Number(this.exchange.amountToPrecision(sym, size));
    if (!(a > 0)) throw new Error(`Size ${size} rounds to 0 for ${sym} (below venue minimum)`);
    return a;
  }

  /** Called by the router before sizing. Returns the leverage chosen (used to cap notional). */
  async prepareLeverage(symbol, entryPrice, slPrice) {
    if (!this.swap) return undefined;
    const sym = await this._prep(symbol);
    const exchangeMax = Number(this.exchange.market(sym)?.limits?.leverage?.max) || 10;
    let lev = Math.min(exchangeMax, this.maxLeverageCap);
    if (this.marginMode === 'isolated') {
      const slFrac = Math.abs(entryPrice - slPrice) / entryPrice;
      lev = Math.min(lev, Math.floor(1 / (slFrac / STOP_TO_LIQ_RATIO + MAINT_MARGIN_AND_FEES)));
    }
    lev = Math.max(1, Math.floor(lev));
    if (!this._modeSet.has(sym)) {
      try { await this.exchange.setMarginMode(this.marginMode, sym, { leverage: lev }); }
      catch (e) { if (!/not modified|110026|already/i.test(e.message)) console.warn(`Could not set ${this.marginMode} margin on ${sym}: ${e.message}. Continuing with the account's current mode.`); }
      this._modeSet.add(sym);
    }
    try { await this.exchange.setLeverage(lev, sym); }
    catch (e) { if (!/not modified|110043/i.test(e.message)) throw new Error(`Could not set ${lev}x leverage on ${sym}: ${e.message}`); }
    this._lev.set(sym, lev);
    return lev;
  }
  leverageFor(symbol) { return this._lev.get(this._sym(symbol)); }

  async getBalance() {
    const b = await this.exchange.fetchBalance();
    return Number(b.USDT?.free ?? b.free?.USDT ?? b.USDT?.total ?? b.total?.USDT ?? 0);
  }

  async placeMarketOrder(symbol, side, size) {
    const sym = await this._prep(symbol);
    const order = await this.exchange.createOrder(sym, 'market', side, this._amt(sym, size));
    let fillPrice = order.average ?? order.price;
    if (!fillPrice) { try { fillPrice = (await this.getPosition(symbol))?.entryPrice; } catch { /* keep undefined */ } }
    return { orderId: order.id, fillPrice };
  }

  async placeStopLoss(symbol, side, size, slPrice) {
    const sym = await this._prep(symbol);
    const price = Number(this.exchange.priceToPrecision(sym, slPrice));
    const order = await this.exchange.createOrder(sym, 'market', side, this._amt(sym, size), undefined, { stopLossPrice: price, reduceOnly: true });
    this._sl.set(sym, order.id);
    return { orderId: order.id };
  }

  async closePercentage(symbol, side, pct) {
    const sym = await this._prep(symbol);
    const position = await this.getPosition(symbol);
    if (!position) throw new Error(`CcxtAdapter(${this.venueName}): no open position for ${symbol}`);
    const closeSize = position.size * (pct / 100);
    const order = await this.exchange.createOrder(sym, 'market', side, this._amt(sym, closeSize), undefined, { reduceOnly: true });
    if (pct >= 100 && this._sl.has(sym)) {
      try { await this.exchange.cancelOrder(this._sl.get(sym), sym); } catch { /* already gone */ }
      this._sl.delete(sym);
    }
    return { orderId: order.id, closedSize: closeSize };
  }

  async moveStopLoss(symbol, orderId, newPrice) {
    const sym = await this._prep(symbol);
    const position = await this.getPosition(symbol);
    if (!position) throw new Error(`CcxtAdapter(${this.venueName}): no open position for ${symbol}`);
    const closingSide = position.side === 'long' ? 'sell' : 'buy';
    const oldId = this._sl.get(sym) ?? orderId;
    const { orderId: newId } = await this.placeStopLoss(symbol, closingSide, position.size, newPrice);
    if (oldId && oldId !== newId) { try { await this.exchange.cancelOrder(oldId, sym); } catch { /* already triggered/cancelled */ } }
    return { orderId: newId };
  }

  async getPosition(symbol) {
    const sym = this._sym(symbol);
    const positions = await this.exchange.fetchPositions([sym]);
    const pos = positions.find((p) => p.symbol === sym && Number(p.contracts) > 0);
    if (!pos) return null;
    return { size: Number(pos.contracts), entryPrice: pos.entryPrice, side: pos.side };
  }

  // --- Limit orders, for the grid bot (core/gridBot.js) ---
  // Grid trading manages many small, independent positions per symbol at
  // once, not one aggregate position — these methods track their own
  // order list (_gridOrders) rather than going through getPosition()/
  // closePercentage() above, which assume a single aggregate position.

  /**
   * Places a resting limit order and tracks it for pollFilledOrders().
   * @param {string} symbol
   * @param {'buy'|'sell'} side
   * @param {number} size
   * @param {number} price
   * @param {{ reduceOnly?: boolean, entryPrice?: number, entryDirection?: 'buy'|'sell' }} [opts]
   *   reduceOnly: true for a closing order, so it only ever reduces an
   *   existing position rather than risking opening/flipping one if the
   *   size is slightly off. entryPrice/entryDirection (the position this
   *   order closes) are required when reduceOnly, so PnL can be computed
   *   on fill — same contract as DryRunAdapter's placeLimitOrder.
   * @returns {Promise<{ orderId: string }>}
   */
  async placeLimitOrder(symbol, side, size, price, opts = {}) {
    if (opts.reduceOnly && (opts.entryPrice === undefined || !opts.entryDirection)) {
      throw new Error('CcxtAdapter.placeLimitOrder: reduceOnly orders need entryPrice and entryDirection to compute PnL on fill');
    }
    const sym = await this._prep(symbol);
    const amt = this._amt(sym, size);
    const px = Number(this.exchange.priceToPrecision(sym, price));
    const params = opts.reduceOnly ? { reduceOnly: true } : {};
    const order = await this.exchange.createOrder(sym, 'limit', side, amt, px, params);
    if (!this._gridOrders.has(sym)) this._gridOrders.set(sym, []);
    this._gridOrders.get(sym).push({
      orderId: order.id, side, size: amt, price: px,
      reduceOnly: !!opts.reduceOnly, entryPrice: opts.entryPrice, entryDirection: opts.entryDirection,
    });
    return { orderId: order.id };
  }

  /** No-op (other than dropping tracking) if the order already filled or doesn't exist. */
  async cancelOrder(symbol, orderId) {
    const sym = await this._prep(symbol);
    try { await this.exchange.cancelOrder(orderId, sym); }
    catch (e) { if (!/not exist|order not found|already|cancel/i.test(e.message)) throw e; }
    const tracked = this._gridOrders.get(sym);
    if (tracked) {
      const idx = tracked.findIndex((o) => o.orderId === orderId);
      if (idx !== -1) tracked.splice(idx, 1);
    }
  }

  /**
   * Checks every order this adapter has placed via placeLimitOrder (and
   * not yet reported filled or canceled) against the exchange, and
   * returns the ones that have genuinely filled since the last call —
   * distinguishing that from one that got canceled or rejected outside
   * our control (e.g. from the exchange UI), which is dropped from
   * tracking but NOT reported as a fill. Call once per tick.
   *
   * @param {string} symbol
   * @returns {Promise<{ orderId: string, side: 'buy'|'sell', size: number, price: number, reduceOnly: boolean, pnl?: number }[]>}
   */
  async pollFilledOrders(symbol) {
    const sym = await this._prep(symbol);
    const tracked = this._gridOrders.get(sym) ?? [];
    if (tracked.length === 0) return [];

    const openOrders = await this.exchange.fetchOpenOrders(sym);
    const openIds = new Set(openOrders.map((o) => o.id));

    const filled = [];
    const stillTracked = [];
    for (const order of tracked) {
      if (openIds.has(order.orderId)) { stillTracked.push(order); continue; }

      let status;
      try { status = await this.exchange.fetchOrder(order.orderId, sym); }
      catch (e) {
        console.warn(`CcxtAdapter(${this.venueName}): could not confirm status of grid order ${order.orderId}, dropping it from tracking: ${e.message}`);
        continue; // drop it — better to lose track of one order than report a fill that may not have happened
      }
      if (status.status !== 'closed' && status.status !== 'filled') continue; // canceled/rejected/expired — not a fill

      const fillPrice = status.average ?? status.price ?? order.price;
      const result = { orderId: order.orderId, side: order.side, size: order.size, price: fillPrice, reduceOnly: order.reduceOnly };
      if (order.reduceOnly) {
        const direction = order.entryDirection === 'buy' ? 1 : -1;
        result.pnl = (fillPrice - order.entryPrice) * order.size * direction;
      }
      filled.push(result);
    }
    this._gridOrders.set(sym, stillTracked);
    return filled;
  }

  /** @returns {Promise<{ orderId: string, side: 'buy'|'sell', size: number, price: number, reduceOnly: boolean }[]>} currently resting, unfilled limit orders this adapter placed */
  async getOpenOrders(symbol) {
    const sym = await this._prep(symbol);
    return (this._gridOrders.get(sym) ?? []).map(
      ({ orderId, side, size, price, reduceOnly }) => ({ orderId, side, size, price, reduceOnly })
    );
  }
}

module.exports = { CcxtAdapter };
