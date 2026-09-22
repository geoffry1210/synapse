/**
 * vwap.js
 * -----------------------------------------------------------------------
 * Volume-Weighted Average Price. Standard public formula:
 *   VWAP = cumulative(typicalPrice * volume) / cumulative(volume)
 *
 * Supports two modes:
 *  - 'cumulative' : runs from the start of the candle array (good for a
 *                    single trading session's worth of candles)
 *  - 'anchored'    : resets the cumulative sums at a given candle index
 *                    (e.g. anchor it to the start of the current impulse
 *                    leg, or to each new day/session boundary)
 * -----------------------------------------------------------------------
 */

/**
 * @param {import('../core/swings').Candle[]} candles
 * @param {{ anchorIndex?: number }} opts
 * @returns {(number|null)[]} VWAP value per candle, aligned by index
 */
function computeVWAP(candles, opts = {}) {
  const anchorIndex = opts.anchorIndex ?? 0;
  const out = new Array(candles.length).fill(null);

  let cumPV = 0;
  let cumVol = 0;

  for (let i = 0; i < candles.length; i++) {
    if (i < anchorIndex) continue;

    const c = candles[i];
    const typicalPrice = (c.high + c.low + c.close) / 3;
    cumPV += typicalPrice * c.volume;
    cumVol += c.volume;

    out[i] = cumVol === 0 ? null : cumPV / cumVol;
  }

  return out;
}

/**
 * Confluence flag: is price on the side of VWAP that supports the given
 * trade direction? (below VWAP supports longs, above supports shorts —
 * matching how Cipher B's VWAP dots are used as a directional filter).
 *
 * @param {import('../core/swings').Candle} candle
 * @param {number|null} vwapValue
 * @param {'bullish'|'bearish'} direction
 * @returns {boolean}
 */
function vwapSupportsDirection(candle, vwapValue, direction) {
  if (vwapValue === null) return false;
  return direction === 'bullish' ? candle.close < vwapValue : candle.close > vwapValue;
}

module.exports = { computeVWAP, vwapSupportsDirection };
