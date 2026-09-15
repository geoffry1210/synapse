/**
 * pumpDetector.js
 * -----------------------------------------------------------------------
 * Flags a pair as "recently pumped" when its price has gained >= a
 * threshold (default 30%) at any point within a rolling window under
 * 24 hours. Works off whatever candle interval you feed it (e.g. 1h
 * candles for a 24h lookback, 15m candles for finer granularity).
 *
 * Definition used: % gain = (currentHigh - lowestLowInWindow) / lowestLowInWindow
 * i.e. how far price has run up from its own recent low — this catches
 * pumps regardless of where exactly the low happened inside the window.
 * -----------------------------------------------------------------------
 */

/**
 * @typedef {Object} PumpFlag
 * @property {number} index
 * @property {number} pctGain
 * @property {number} windowLowIndex
 * @property {number} windowLow
 */

/**
 * @param {import('../core/swings').Candle[]} candles
 * @param {{ windowCandles?: number, thresholdPct?: number }} opts
 *   windowCandles: how many candles back count as "within 24h" for your
 *   chosen candle interval (e.g. 24 for 1h candles, 96 for 15m candles).
 * @returns {PumpFlag[]}
 */
function detectPumps(candles, opts = {}) {
  const windowCandles = opts.windowCandles ?? 24;
  const thresholdPct = opts.thresholdPct ?? 30;

  const flags = [];

  for (let i = 0; i < candles.length; i++) {
    const windowStart = Math.max(0, i - windowCandles + 1);
    let lowIdx = windowStart;
    for (let j = windowStart; j <= i; j++) {
      if (candles[j].low < candles[lowIdx].low) lowIdx = j;
    }

    const windowLow = candles[lowIdx].low;
    if (windowLow <= 0) continue;

    const pctGain = ((candles[i].high - windowLow) / windowLow) * 100;
    if (pctGain >= thresholdPct) {
      flags.push({ index: i, pctGain, windowLowIndex: lowIdx, windowLow });
    }
  }

  return flags;
}

/**
 * Convenience: has this pair pumped as of the *latest* candle only?
 * Useful for a live scanner polling loop (check just the newest bar).
 *
 * @param {import('../core/swings').Candle[]} candles
 * @param {{ windowCandles?: number, thresholdPct?: number }} opts
 * @returns {PumpFlag|null}
 */
function checkLatestPump(candles, opts = {}) {
  if (candles.length === 0) return null;
  const flags = detectPumps(candles, opts);
  const last = flags[flags.length - 1];
  return last && last.index === candles.length - 1 ? last : null;
}

module.exports = { detectPumps, checkLatestPump };
