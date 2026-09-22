/**
 * mfi.js
 * -----------------------------------------------------------------------
 * Money Flow Index — standard public formula (volume-weighted RSI):
 *   1. Typical Price (TP) = (High + Low + Close) / 3
 *   2. Raw Money Flow = TP * Volume
 *   3. Over the lookback period, split raw money flow into "positive"
 *      (days where TP rose vs the prior day) and "negative" (TP fell)
 *   4. Money Flow Ratio = sum(positive) / sum(negative)
 *   5. MFI = 100 - (100 / (1 + Money Flow Ratio))
 * -----------------------------------------------------------------------
 */

const DEFAULT_PERIOD = 14;

/**
 * @param {import('../core/swings').Candle[]} candles
 * @param {number} period
 * @returns {(number|null)[]} MFI value per candle, aligned by index
 */
function computeMFI(candles, period = DEFAULT_PERIOD) {
  const typicalPrices = candles.map((c) => (c.high + c.low + c.close) / 3);
  const rawFlow = typicalPrices.map((tp, i) => tp * candles[i].volume);

  const out = new Array(candles.length).fill(null);

  for (let i = period; i < candles.length; i++) {
    let positive = 0;
    let negative = 0;

    for (let j = i - period + 1; j <= i; j++) {
      if (typicalPrices[j] > typicalPrices[j - 1]) positive += rawFlow[j];
      else if (typicalPrices[j] < typicalPrices[j - 1]) negative += rawFlow[j];
      // unchanged typical price contributes to neither
    }

    if (negative === 0) {
      out[i] = 100; // no negative flow at all -> maximally overbought
    } else {
      const moneyFlowRatio = positive / negative;
      out[i] = 100 - 100 / (1 + moneyFlowRatio);
    }
  }

  return out;
}

/**
 * Confluence flag: is MFI in the zone that supports the given direction?
 * Oversold (<20) supports longs, overbought (>80) supports shorts.
 *
 * @param {number|null} mfiValue
 * @param {'bullish'|'bearish'} direction
 * @param {{ oversold?: number, overbought?: number }} thresholds
 * @returns {boolean}
 */
function mfiSupportsDirection(mfiValue, direction, thresholds = {}) {
  const { oversold = 20, overbought = 80 } = thresholds;
  if (mfiValue === null) return false;
  return direction === 'bullish' ? mfiValue < oversold : mfiValue > overbought;
}

module.exports = { computeMFI, mfiSupportsDirection, DEFAULT_PERIOD };
