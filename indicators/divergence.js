/**
 * divergence.js
 * -----------------------------------------------------------------------
 * Detects classic regular divergence between price and an oscillator
 * (RSI, StochRSI, etc.) by comparing the two most recent price swing
 * highs/lows against the oscillator's value at those same points.
 *
 *   Bearish divergence: price makes a HIGHER high, oscillator makes a
 *                        LOWER high  -> momentum fading on the way up.
 *   Bullish divergence: price makes a LOWER low, oscillator makes a
 *                        HIGHER low  -> momentum fading on the way down.
 * -----------------------------------------------------------------------
 */

const { findSwings } = require('../core/swings');

/**
 * @param {import('../core/swings').Candle[]} candles
 * @param {(number|null)[]} oscillatorValues - aligned by index with candles
 * @param {number} lookback - swing detection lookback (see swings.js)
 * @returns {{ bearish: boolean, bullish: boolean, details: object }}
 */
function detectDivergence(candles, oscillatorValues, lookback = 2) {
  const swings = findSwings(candles, lookback);
  const highs = swings.filter((s) => s.type === 'high');
  const lows = swings.filter((s) => s.type === 'low');

  const result = { bearish: false, bullish: false, details: {} };

  if (highs.length >= 2) {
    const [prevHigh, lastHigh] = highs.slice(-2);
    const prevOsc = oscillatorValues[prevHigh.index];
    const lastOsc = oscillatorValues[lastHigh.index];

    if (prevOsc !== null && lastOsc !== null && lastHigh.price > prevHigh.price && lastOsc < prevOsc) {
      result.bearish = true;
      result.details.bearish = { prevHigh, lastHigh, prevOsc, lastOsc };
    }
  }

  if (lows.length >= 2) {
    const [prevLow, lastLow] = lows.slice(-2);
    const prevOsc = oscillatorValues[prevLow.index];
    const lastOsc = oscillatorValues[lastLow.index];

    if (prevOsc !== null && lastOsc !== null && lastLow.price < prevLow.price && lastOsc > prevOsc) {
      result.bullish = true;
      result.details.bullish = { prevLow, lastLow, prevOsc, lastOsc };
    }
  }

  return result;
}

module.exports = { detectDivergence };
