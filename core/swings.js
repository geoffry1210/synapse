/**
 * swings.js
 * -----------------------------------------------------------------------
 * Detects swing highs and swing lows from OHLCV candle data using a
 * standard fractal method: a candle is a swing high if its high is
 * greater than the `lookback` candles on either side of it, and a swing
 * low if its low is lower than the `lookback` candles on either side.
 *
 * This is the foundation everything else (BOS/CHoCH/OB detection) is
 * built on, so it's kept dependency-free and easy to unit test.
 * -----------------------------------------------------------------------
 */

/**
 * @typedef {Object} Candle
 * @property {number} time   - unix timestamp (ms)
 * @property {number} open
 * @property {number} high
 * @property {number} low
 * @property {number} close
 * @property {number} volume
 */

/**
 * @typedef {Object} Swing
 * @property {number} index  - index into the candles array
 * @property {number} time
 * @property {number} price  - the high or low price of the swing
 * @property {'high'|'low'} type
 */

/**
 * Find all swing highs and swing lows in a candle series.
 *
 * @param {Candle[]} candles
 * @param {number} lookback - how many candles on each side must be
 *                             lower/higher for a point to count as a swing.
 *                             Larger = fewer, more "major" swings.
 * @returns {Swing[]} swings in chronological order
 */
function findSwings(candles, lookback = 3) {
  const swings = [];

  for (let i = lookback; i < candles.length - lookback; i++) {
    const current = candles[i];
    let isSwingHigh = true;
    let isSwingLow = true;

    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (candles[j].high >= current.high) isSwingHigh = false;
      if (candles[j].low <= current.low) isSwingLow = false;
    }

    if (isSwingHigh) {
      swings.push({ index: i, time: current.time, price: current.high, type: 'high' });
    }
    if (isSwingLow) {
      swings.push({ index: i, time: current.time, price: current.low, type: 'low' });
    }
  }

  return swings;
}

/**
 * Reduce a raw swing list down to alternating high/low points only
 * (removes consecutive same-type swings, keeping the most extreme one).
 * This gives a clean zig-zag structure to feed into BOS/CHoCH detection.
 *
 * @param {Swing[]} swings
 * @returns {Swing[]}
 */
function toZigZag(swings) {
  if (swings.length === 0) return [];

  const zigzag = [swings[0]];

  for (let i = 1; i < swings.length; i++) {
    const last = zigzag[zigzag.length - 1];
    const current = swings[i];

    if (current.type === last.type) {
      // Same type in a row — keep whichever is more extreme.
      const shouldReplace =
        (current.type === 'high' && current.price > last.price) ||
        (current.type === 'low' && current.price < last.price);
      if (shouldReplace) zigzag[zigzag.length - 1] = current;
    } else {
      zigzag.push(current);
    }
  }

  return zigzag;
}

module.exports = { findSwings, toZigZag };
