/**
 * rsi.js
 * -----------------------------------------------------------------------
 * Relative Strength Index — standard public formula using Wilder's
 * smoothing method.
 * -----------------------------------------------------------------------
 */

const DEFAULT_PERIOD = 14;

/**
 * @param {import('../core/swings').Candle[]} candles
 * @param {number} period
 * @returns {(number|null)[]} RSI value per candle, aligned by index
 */
function computeRSI(candles, period = DEFAULT_PERIOD) {
  const out = new Array(candles.length).fill(null);
  if (candles.length <= period) return out;

  let gainSum = 0;
  let lossSum = 0;

  for (let i = 1; i <= period; i++) {
    const change = candles[i].close - candles[i - 1].close;
    if (change > 0) gainSum += change;
    else lossSum -= change;
  }

  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  out[period] = rsiFromAverages(avgGain, avgLoss);

  for (let i = period + 1; i < candles.length; i++) {
    const change = candles[i].close - candles[i - 1].close;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;

    // Wilder's smoothing (like an EMA with alpha = 1/period)
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;

    out[i] = rsiFromAverages(avgGain, avgLoss);
  }

  return out;
}

function rsiFromAverages(avgGain, avgLoss) {
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/**
 * Confluence flag: RSI in the zone supporting the given direction.
 * @param {number|null} rsiValue
 * @param {'bullish'|'bearish'} direction
 * @param {{ oversold?: number, overbought?: number }} thresholds
 */
function rsiSupportsDirection(rsiValue, direction, thresholds = {}) {
  const { oversold = 30, overbought = 70 } = thresholds;
  if (rsiValue === null) return false;
  return direction === 'bullish' ? rsiValue < oversold : rsiValue > overbought;
}

module.exports = { computeRSI, rsiSupportsDirection, DEFAULT_PERIOD };
