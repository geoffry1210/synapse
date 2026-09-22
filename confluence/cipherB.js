/**
 * cipherB.js
 * -----------------------------------------------------------------------
 * Evaluates the 3 mandatory Cipher B confluences (WaveTrend dot, MFI,
 * VWAP) for a given candle + trade direction, and reports flags into a
 * SetupManager instance. This is the mandatory trio — the 2 optional
 * confluences (RSI, StochRSI, FRVP, candle pattern) plug in the same way
 * via their own modules (not built yet) using the same
 * `setupManager.onConfluenceFlag('optional', name)` interface.
 * -----------------------------------------------------------------------
 */

const { computeWaveTrend } = require('../indicators/waveTrend');
const { computeVWAP, vwapSupportsDirection } = require('../indicators/vwap');
const { computeMFI, mfiSupportsDirection } = require('../indicators/mfi');

/**
 * Precompute all three indicator series once for a candle set. Reuse the
 * same result across every candle you check, rather than recomputing
 * from scratch each time (these are full-series calculations).
 *
 * @param {import('../core/swings').Candle[]} candles
 * @param {{ vwapAnchorIndex?: number, waveTrendOpts?: object, mfiPeriod?: number }} opts
 */
function precomputeCipherB(candles, opts = {}) {
  return {
    waveTrend: computeWaveTrend(candles, opts.waveTrendOpts),
    vwap: computeVWAP(candles, { anchorIndex: opts.vwapAnchorIndex }),
    mfi: computeMFI(candles, opts.mfiPeriod),
  };
}

/**
 * Evaluate the 3 mandatory flags for one candle + direction.
 *
 * @param {import('../core/swings').Candle} candle
 * @param {number} index
 * @param {'bullish'|'bearish'} direction
 * @param {ReturnType<typeof precomputeCipherB>} precomputed
 * @returns {{ waveTrendDot: boolean, mfi: boolean, vwap: boolean }}
 */
function evaluateCipherB(candle, index, direction, precomputed) {
  const wtPoint = precomputed.waveTrend[index];
  const waveTrendDot = !!wtPoint && wtPoint.dot === direction;

  const mfi = mfiSupportsDirection(precomputed.mfi[index], direction);
  const vwap = vwapSupportsDirection(candle, precomputed.vwap[index], direction);

  return { waveTrendDot, mfi, vwap };
}

/**
 * Convenience: evaluate Cipher B for the active setup on a SetupManager
 * and report any newly-true flags into it. Call this once per candle,
 * after `setupManager.onPriceUpdate()`, while the setup is
 * IN_ZONE_AWAITING_CONFLUENCE.
 *
 * @param {import('../core/setupManager').SetupManager} setupManager
 * @param {import('../core/swings').Candle} candle
 * @param {number} index
 * @param {ReturnType<typeof precomputeCipherB>} precomputed
 */
function reportCipherBFlags(setupManager, candle, index, precomputed) {
  const setup = setupManager.activeSetup;
  if (!setup || setup.status !== 'IN_ZONE_AWAITING_CONFLUENCE') return;

  const flags = evaluateCipherB(candle, index, setup.direction, precomputed);
  for (const [name, isTrue] of Object.entries(flags)) {
    if (isTrue) setupManager.onConfluenceFlag('mandatory', name);
  }
}

module.exports = { precomputeCipherB, evaluateCipherB, reportCipherBFlags };
