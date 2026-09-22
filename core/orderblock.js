/**
 * orderblock.js
 * -----------------------------------------------------------------------
 * Identifies the "major" order block associated with a BOS/CHoCH event,
 * and tracks whether it's still valid (per the rule: an order block is
 * invalidated the moment a candle *wicks through* it, i.e. price trades
 * beyond the OB's far boundary even without closing there).
 *
 * Standard SMC definition used:
 *  - Bullish OB = the last bearish (down-close) candle before the
 *                 impulse leg that broke structure upward.
 *  - Bearish OB = the last bullish (up-close) candle before the
 *                 impulse leg that broke structure downward.
 * -----------------------------------------------------------------------
 */

/**
 * @typedef {Object} OrderBlock
 * @property {'bullish'|'bearish'} direction
 * @property {number} index        - candle index of the OB candle
 * @property {number} high
 * @property {number} low
 * @property {number} open
 * @property {number} close
 * @property {StructureEvent} sourceEvent - the BOS/CHoCH that produced it
 * @property {boolean} valid       - false once invalidated
 * @property {number|null} invalidatedAtIndex
 */

/**
 * Find the order block candle for a given structure event by scanning
 * backward from the start of its impulse leg for the last opposing-color
 * candle.
 *
 * @param {import('./swings').Candle[]} candles
 * @param {import('./structure').StructureEvent} event
 * @returns {OrderBlock|null}
 */
function findOrderBlock(candles, event) {
  const legStartIndex = event.legStart.index;

  // Scan backward from the leg start looking for the last candle whose
  // close direction is *opposite* to the impulse direction.
  for (let i = legStartIndex; i >= 0; i--) {
    const c = candles[i];
    const isBearishCandle = c.close < c.open;
    const isBullishCandle = c.close > c.open;

    if (event.direction === 'bullish' && isBearishCandle) {
      return buildOB(c, i, event);
    }
    if (event.direction === 'bearish' && isBullishCandle) {
      return buildOB(c, i, event);
    }
  }

  return null; // no opposing candle found (shouldn't normally happen)
}

function buildOB(candle, index, event) {
  return {
    direction: event.direction,
    index,
    high: candle.high,
    low: candle.low,
    open: candle.open,
    close: candle.close,
    sourceEvent: event,
    valid: true,
    invalidatedAtIndex: null,
  };
}

/**
 * Check a stream of candles *after* the OB was formed for the first wick
 * that pierces through the OB's far boundary. Call this incrementally as
 * new candles arrive, or in a loop for backtesting.
 *
 * Bullish OB (acts as support): invalidated the moment a candle's low
 *   trades below the OB's low.
 * Bearish OB (acts as resistance): invalidated the moment a candle's
 *   high trades above the OB's high.
 *
 * @param {OrderBlock} ob
 * @param {import('./swings').Candle} candle
 * @param {number} candleIndex
 * @returns {OrderBlock} the same OB object, mutated if just invalidated
 */
function checkInvalidation(ob, candle, candleIndex) {
  if (!ob.valid || candleIndex <= ob.index) return ob;

  const pierced =
    ob.direction === 'bullish' ? candle.low < ob.low : candle.high > ob.high;

  if (pierced) {
    ob.valid = false;
    ob.invalidatedAtIndex = candleIndex;
  }

  return ob;
}

/**
 * Is price currently trading inside the OB's zone (high-low range)?
 * Used to gate when the confluence engine should start watching.
 *
 * @param {OrderBlock} ob
 * @param {import('./swings').Candle} candle
 * @returns {boolean}
 */
function isPriceInZone(ob, candle) {
  if (!ob.valid) return false;
  return candle.low <= ob.high && candle.high >= ob.low;
}

module.exports = { findOrderBlock, checkInvalidation, isPriceInZone };
