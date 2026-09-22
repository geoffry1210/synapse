/**
 * adapterInterface.js
 * -----------------------------------------------------------------------
 * This isn't enforced by the language (plain JS, no abstract classes) —
 * it's the contract every venue adapter (ccxt, Weex, MT5, dry-run) must
 * implement so ExecutionRouter can treat them all identically. Documented
 * here as the single source of truth for that shape.
 *
 * interface ExchangeAdapter {
 *   venueName: string
 *
 *   async getBalance(): Promise<number>
 *     Returns available balance in the account's quote currency.
 *
 *   async placeMarketOrder(symbol, side, size): Promise<{ orderId, fillPrice }>
 *     side: 'buy' | 'sell'. Opens a new position.
 *
 *   async placeStopLoss(symbol, side, size, slPrice): Promise<{ orderId }>
 *     side is the CLOSING side (opposite of the position's side).
 *
 *   async closePercentage(symbol, side, pct): Promise<{ orderId, closedSize }>
 *     Closes `pct` (0-100) of the currently open position. side is the
 *     closing side.
 *
 *   async moveStopLoss(symbol, orderId, newPrice): Promise<void>
 *     Moves an existing SL order to a new price (used for SL-to-breakeven
 *     after TP1).
 *
 *   async getPosition(symbol): Promise<{ size, entryPrice, side } | null>
 * }
 *
 * All methods are async and should throw on failure — ExecutionRouter
 * uses Promise.allSettled across venues, so one venue's failure never
 * blocks the others.
 * -----------------------------------------------------------------------
 */

module.exports = {}; // documentation-only module
