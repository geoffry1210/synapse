/**
 * stochRsi.js
 * -----------------------------------------------------------------------
 * Stochastic RSI — standard public formula: apply the Stochastic
 * oscillator formula to RSI values instead of price, then smooth with
 * %K/%D moving averages.
 *
 *   StochRSI = (RSI - lowestRSI(period)) / (highestRSI(period) - lowestRSI(period))
 *   %K = SMA(StochRSI, kSmoothing)
 *   %D = SMA(%K, dSmoothing)
 *
 * Output is scaled 0-100 to match common charting convention.
 * -----------------------------------------------------------------------
 */

const { computeRSI } = require('./rsi');
const { sma } = require('./mathUtils');

const DEFAULTS = {
  rsiPeriod: 14,
  stochPeriod: 14,
  kSmoothing: 3,
  dSmoothing: 3,
};

/**
 * @param {import('../core/swings').Candle[]} candles
 * @param {Partial<typeof DEFAULTS>} opts
 * @returns {{ k: (number|null)[], d: (number|null)[] }}
 */
function computeStochRSI(candles, opts = {}) {
  const { rsiPeriod, stochPeriod, kSmoothing, dSmoothing } = { ...DEFAULTS, ...opts };

  const rsi = computeRSI(candles, rsiPeriod);
  const rawStoch = new Array(candles.length).fill(null);

  for (let i = 0; i < candles.length; i++) {
    if (rsi[i] === null) continue;

    const windowStart = i - stochPeriod + 1;
    if (windowStart < 0) continue;

    let hasNull = false;
    let lo = Infinity;
    let hi = -Infinity;
    for (let j = windowStart; j <= i; j++) {
      if (rsi[j] === null) {
        hasNull = true;
        break;
      }
      if (rsi[j] < lo) lo = rsi[j];
      if (rsi[j] > hi) hi = rsi[j];
    }
    if (hasNull) continue;

    rawStoch[i] = hi === lo ? 0 : ((rsi[i] - lo) / (hi - lo)) * 100;
  }

  const rawForSma = rawStoch.map((v) => (v === null ? 0 : v));
  const kRaw = sma(rawForSma, kSmoothing);
  const k = kRaw.map((v, i) => (rawStoch[i] === null ? null : v));

  const kForSma = k.map((v) => (v === null ? 0 : v));
  const dRaw = sma(kForSma, dSmoothing);
  const d = dRaw.map((v, i) => (k[i] === null ? null : v));

  return { k, d };
}

/**
 * Confluence flag: StochRSI %K in the zone supporting the given direction.
 * @param {number|null} kValue
 * @param {'bullish'|'bearish'} direction
 * @param {{ oversold?: number, overbought?: number }} thresholds
 */
function stochRsiSupportsDirection(kValue, direction, thresholds = {}) {
  const { oversold = 20, overbought = 80 } = thresholds;
  if (kValue === null) return false;
  return direction === 'bullish' ? kValue < oversold : kValue > overbought;
}

module.exports = { computeStochRSI, stochRsiSupportsDirection, DEFAULTS };
