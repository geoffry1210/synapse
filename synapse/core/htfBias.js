/**
 * htfBias.js
 * -----------------------------------------------------------------------
 * Determines the overall directional bias — bullish, bearish, or ranging —
 * from higher-timeframe (1D + 4H) swing structure. This is the top-level
 * filter: order blocks are only searched for on the LTF (2H-30m) in the
 * direction of this bias, unless a counter-trend override applies (see
 * biasOverride.js).
 *
 * Method: reduce each timeframe's candles to a zig-zag of swing points,
 * then look at the most recent run of swings. Bullish = the last swing
 * highs are strictly rising AND the last swing lows are strictly rising
 * (clean HH/HL). Bearish = the mirror (LH/LL). Anything else — mixed,
 * overlapping, or too few swings to tell — is ranging.
 *
 * 1D and 4H must AGREE for a non-ranging bias. If they disagree, that's
 * exactly the kind of ambiguous, overlapping-structure situation "ranging"
 * is meant to catch — trading through it is how most whipsaw losses
 * happen.
 * -----------------------------------------------------------------------
 */

const { findSwings, toZigZag } = require('./swings');

/**
 * @param {import('./swings').Candle[]} candles
 * @param {{ lookback?: number, swingCount?: number }} opts
 * @returns {'bullish'|'bearish'|'ranging'}
 */
function classifyTrend(candles, opts = {}) {
  const lookback = opts.lookback ?? 2;
  const swingCount = opts.swingCount ?? 6;

  const zigzag = toZigZag(findSwings(candles, lookback));
  const recent = zigzag.slice(-swingCount);

  const highs = recent.filter((s) => s.type === 'high').map((s) => s.price);
  const lows = recent.filter((s) => s.type === 'low').map((s) => s.price);

  // Need at least 2 of each to compare a trend of highs vs a trend of lows.
  if (highs.length < 2 || lows.length < 2) return 'ranging';

  const strictlyRising = (arr) => arr.every((v, i) => i === 0 || v > arr[i - 1]);
  const strictlyFalling = (arr) => arr.every((v, i) => i === 0 || v < arr[i - 1]);

  if (strictlyRising(highs) && strictlyRising(lows)) return 'bullish';
  if (strictlyFalling(highs) && strictlyFalling(lows)) return 'bearish';
  return 'ranging';
}

/**
 * @param {import('./swings').Candle[]} dailyCandles - 1D candles
 * @param {import('./swings').Candle[]} fourHourCandles - 4H candles
 * @param {{ lookback?: number, swingCount?: number }} opts
 * @returns {{ bias: 'bullish'|'bearish'|'ranging', daily: string, fourHour: string }}
 */
function computeHtfBias(dailyCandles, fourHourCandles, opts = {}) {
  const daily = classifyTrend(dailyCandles, opts);
  const fourHour = classifyTrend(fourHourCandles, opts);

  const bias = daily !== 'ranging' && daily === fourHour ? daily : 'ranging';

  return { bias, daily, fourHour };
}

module.exports = { classifyTrend, computeHtfBias };
