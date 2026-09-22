/**
 * waveTrend.js
 * -----------------------------------------------------------------------
 * WaveTrend Oscillator — originally published as open-source Pine Script
 * by LazyBear, and the public formula underlying Cipher B's core dot
 * signal. Two lines (WT1 fast, WT2 = SMA of WT1) oscillate around zero;
 * a cross of WT1 over/under WT2 while beyond an extreme threshold is the
 * green/red dot.
 *
 * Threshold note: the "textbook" extreme zone is often quoted as ±60,
 * but this project uses ±45 per your calibration.
 * -----------------------------------------------------------------------
 */

const { ema, sma } = require('./mathUtils');

const DEFAULTS = {
  channelLength: 10,
  avgLength: 21,
  signalLength: 4,
  extremeThreshold: 45, // your calibrated value (default is often 60)
};

/**
 * @typedef {Object} WaveTrendPoint
 * @property {number|null} wt1
 * @property {number|null} wt2
 * @property {'bullish'|'bearish'|null} dot - non-null only on the candle
 *   where WT1 crosses WT2 while beyond the extreme threshold
 */

/**
 * @param {import('../core/swings').Candle[]} candles
 * @param {Partial<typeof DEFAULTS>} opts
 * @returns {WaveTrendPoint[]} one entry per candle, aligned by index
 */
function computeWaveTrend(candles, opts = {}) {
  const { channelLength, avgLength, signalLength, extremeThreshold } = { ...DEFAULTS, ...opts };

  const ap = candles.map((c) => (c.high + c.low + c.close) / 3); // hlc3
  const esa = ema(ap, channelLength);

  const absDiff = ap.map((v, i) => (esa[i] === null ? 0 : Math.abs(v - esa[i])));
  const d = ema(absDiff, channelLength);

  const ci = ap.map((v, i) => {
    if (esa[i] === null || d[i] === null || d[i] === 0) return null;
    return (v - esa[i]) / (0.015 * d[i]);
  });

  // ema() expects a plain numeric array — feed it 0 where ci is null so
  // indices line up, then blank those slots back out afterward.
  const ciForEma = ci.map((v) => (v === null ? 0 : v));
  const wt1Raw = ema(ciForEma, avgLength);
  const wt1 = wt1Raw.map((v, i) => (ci[i] === null ? null : v));

  const wt1ForSma = wt1.map((v) => (v === null ? 0 : v));
  const wt2Raw = sma(wt1ForSma, signalLength);
  const wt2 = wt2Raw.map((v, i) => (wt1[i] === null ? null : v));

  const points = candles.map((_, i) => ({ wt1: wt1[i], wt2: wt2[i], dot: null }));

  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const cur = points[i];
    if (cur.wt1 === null || cur.wt2 === null || prev.wt1 === null || prev.wt2 === null) continue;

    const crossedUp = prev.wt1 <= prev.wt2 && cur.wt1 > cur.wt2;
    const crossedDown = prev.wt1 >= prev.wt2 && cur.wt1 < cur.wt2;

    // Bullish dot: cross up while deep in oversold territory (both lines
    // below -threshold). Bearish dot: cross down while overbought.
    if (crossedUp && cur.wt1 < -extremeThreshold && cur.wt2 < -extremeThreshold) {
      cur.dot = 'bullish';
    } else if (crossedDown && cur.wt1 > extremeThreshold && cur.wt2 > extremeThreshold) {
      cur.dot = 'bearish';
    }
  }

  return points;
}

module.exports = { computeWaveTrend, DEFAULTS };
