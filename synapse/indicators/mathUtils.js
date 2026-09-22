/**
 * mathUtils.js
 * -----------------------------------------------------------------------
 * Small dependency-free EMA/SMA helpers shared by the indicator modules.
 * All functions take a plain array of numbers and return an array of the
 * same length, with `null` for indices where there isn't enough warmup
 * data yet (so callers can align results 1:1 with the candle array by
 * index).
 * -----------------------------------------------------------------------
 */

/**
 * Simple moving average.
 * @param {number[]} values
 * @param {number} period
 * @returns {(number|null)[]}
 */
function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;

  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }

  return out;
}

/**
 * Exponential moving average. Seeds with an SMA of the first `period`
 * values, matching how most charting platforms (incl. TradingView) do it.
 * @param {number[]} values
 * @param {number} period
 * @returns {(number|null)[]}
 */
function ema(values, period) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  let prev = null;

  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) continue;
    if (i === period - 1) {
      // seed with SMA of the first `period` values
      let sum = 0;
      for (let j = 0; j <= i; j++) sum += values[j];
      prev = sum / period;
      out[i] = prev;
      continue;
    }
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }

  return out;
}

module.exports = { sma, ema };
