/**
 * candlePattern.js
 * -----------------------------------------------------------------------
 * Detects standard, publicly-documented candlestick reversal patterns:
 * bullish/bearish engulfing, hammer, shooting star. Each detector looks
 * only at the current candle (+ previous candle for engulfing patterns)
 * — no proprietary logic, just textbook pattern definitions.
 * -----------------------------------------------------------------------
 */

/**
 * @param {import('../core/swings').Candle} candle
 * @returns {{ body: number, range: number, upperWick: number, lowerWick: number, bullish: boolean }}
 */
function candleMetrics(candle) {
  const body = Math.abs(candle.close - candle.open);
  const range = candle.high - candle.low;
  const upperWick = candle.high - Math.max(candle.open, candle.close);
  const lowerWick = Math.min(candle.open, candle.close) - candle.low;
  return { body, range, upperWick, lowerWick, bullish: candle.close > candle.open };
}

/**
 * Bullish engulfing: current bullish candle's body fully engulfs the
 * previous bearish candle's body.
 */
function isBullishEngulfing(prev, cur) {
  const prevM = candleMetrics(prev);
  const curM = candleMetrics(cur);
  return (
    !prevM.bullish &&
    curM.bullish &&
    cur.close > prev.open &&
    cur.open < prev.close
  );
}

/**
 * Bearish engulfing: current bearish candle's body fully engulfs the
 * previous bullish candle's body.
 */
function isBearishEngulfing(prev, cur) {
  const prevM = candleMetrics(prev);
  const curM = candleMetrics(cur);
  return (
    prevM.bullish &&
    !curM.bullish &&
    cur.open > prev.close &&
    cur.close < prev.open
  );
}

/**
 * Hammer: small body near the top of the range, long lower wick
 * (>= 2x body), little/no upper wick. Bullish reversal signal, most
 * meaningful after a decline.
 */
function isHammer(candle) {
  const m = candleMetrics(candle);
  if (m.range === 0) return false;
  return m.lowerWick >= m.body * 2 && m.upperWick <= m.body * 0.5 && m.body / m.range < 0.4;
}

/**
 * Shooting star: small body near the bottom of the range, long upper
 * wick (>= 2x body), little/no lower wick. Bearish reversal signal,
 * most meaningful after a rally.
 */
function isShootingStar(candle) {
  const m = candleMetrics(candle);
  if (m.range === 0) return false;
  return m.upperWick >= m.body * 2 && m.lowerWick <= m.body * 0.5 && m.body / m.range < 0.4;
}

/**
 * Confluence flag: does a recognized reversal pattern support the given
 * direction on this candle (checking the current + previous candle)?
 *
 * @param {import('../core/swings').Candle[]} candles
 * @param {number} index
 * @param {'bullish'|'bearish'} direction
 * @returns {boolean}
 */
function candlePatternSupportsDirection(candles, index, direction) {
  if (index < 1) return false;
  const prev = candles[index - 1];
  const cur = candles[index];

  if (direction === 'bullish') {
    return isBullishEngulfing(prev, cur) || isHammer(cur);
  }
  return isBearishEngulfing(prev, cur) || isShootingStar(cur);
}

module.exports = {
  candleMetrics,
  isBullishEngulfing,
  isBearishEngulfing,
  isHammer,
  isShootingStar,
  candlePatternSupportsDirection,
};
