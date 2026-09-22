/**
 * optional.js
 * -----------------------------------------------------------------------
 * Evaluates the 4 optional confluences (RSI, StochRSI, FRVP, candle
 * pattern) — your rule requires any 2 of these 4, on top of the
 * mandatory Cipher B trio, before an entry fires.
 *
 * FRVP is computed per-setup (it needs the specific BOS/CHoCH leg range
 * as its fixed range), while RSI/StochRSI are precomputed once for the
 * whole candle series like the Cipher B indicators.
 * -----------------------------------------------------------------------
 */

const { computeRSI, rsiSupportsDirection } = require('../indicators/rsi');
const { computeStochRSI, stochRsiSupportsDirection } = require('../indicators/stochRsi');
const { computeFRVP, frvpSupportsDirection } = require('../indicators/frvp');
const { candlePatternSupportsDirection } = require('../indicators/candlePattern');

/**
 * @param {import('../core/swings').Candle[]} candles
 * @param {{ rsiPeriod?: number, stochRsiOpts?: object }} opts
 */
function precomputeOptional(candles, opts = {}) {
  return {
    rsi: computeRSI(candles, opts.rsiPeriod),
    stochRsi: computeStochRSI(candles, opts.stochRsiOpts),
  };
}

/**
 * Evaluate all 4 optional flags for one candle + direction.
 *
 * @param {import('../core/swings').Candle[]} candles
 * @param {number} index
 * @param {'bullish'|'bearish'} direction
 * @param {ReturnType<typeof precomputeOptional>} precomputed
 * @param {import('../indicators/frvp').FRVPResult|null} frvp - computed
 *   once per setup over its BOS/CHoCH leg range (see computeFRVP)
 * @returns {{ rsi: boolean, stochRsi: boolean, frvp: boolean, candlePattern: boolean }}
 */
function evaluateOptional(candles, index, direction, precomputed, frvp) {
  const candle = candles[index];

  return {
    rsi: rsiSupportsDirection(precomputed.rsi[index], direction),
    stochRsi: stochRsiSupportsDirection(precomputed.stochRsi.k[index], direction),
    frvp: frvpSupportsDirection(candle.close, frvp, direction),
    candlePattern: candlePatternSupportsDirection(candles, index, direction),
  };
}

/**
 * Reports any newly-true optional flags into the SetupManager. Call once
 * per candle, alongside reportCipherBFlags(), while the setup is
 * IN_ZONE_AWAITING_CONFLUENCE.
 *
 * @param {import('../core/setupManager').SetupManager} setupManager
 * @param {import('../core/swings').Candle[]} candles
 * @param {number} index
 * @param {ReturnType<typeof precomputeOptional>} precomputed
 * @param {import('../indicators/frvp').FRVPResult|null} frvp
 */
function reportOptionalFlags(setupManager, candles, index, precomputed, frvp) {
  const setup = setupManager.activeSetup;
  if (!setup || setup.status !== 'IN_ZONE_AWAITING_CONFLUENCE') return;

  const flags = evaluateOptional(candles, index, setup.direction, precomputed, frvp);
  for (const [name, isTrue] of Object.entries(flags)) {
    if (isTrue) setupManager.onConfluenceFlag('optional', name);
  }
}

/**
 * Convenience: compute FRVP for a setup's BOS/CHoCH leg range. Call once
 * when the setup is created and cache the result on the setup itself.
 *
 * @param {import('../core/swings').Candle[]} candles
 * @param {import('../core/structure').StructureEvent} structureEvent
 */
function computeFRVPForSetup(candles, structureEvent) {
  const startIndex = Math.min(structureEvent.legStart.index, structureEvent.legEnd.index);
  const endIndex = Math.max(structureEvent.legStart.index, structureEvent.legEnd.index);
  return computeFRVP(candles, startIndex, endIndex);
}

module.exports = { precomputeOptional, evaluateOptional, reportOptionalFlags, computeFRVPForSetup };
