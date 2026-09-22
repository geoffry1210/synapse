/**
 * fibonacci.js
 * -----------------------------------------------------------------------
 * Computes the fib levels used for entry/SL/TP, anchored on the full
 * impulse leg that produced the BOS/CHoCH (legStart -> legEnd from the
 * structure event).
 *
 * Convention:
 *   0   = legStart (the origin of the impulse leg — the swing the OB
 *                    sits at, where price retraces back to for entry)
 *   1   = legEnd   (the extreme point that confirmed the break)
 *
 * So for a bullish leg (price moved up from legStart to legEnd):
 *   - fib 0     = legStart.price (origin / OB side)  -> your entry level
 *   - fib -0.27 = below fib 0                          -> stop loss (below the OB)
 *   - fib 0.3 / 0.618 / 0.9 = between legStart and legEnd -> take profits,
 *     price moving back up toward (but not necessarily reaching) the prior extreme
 *
 * For a bearish leg it mirrors: fib 0 is the high origin, targets sit below it.
 * -----------------------------------------------------------------------
 */

/**
 * @typedef {Object} FibLevels
 * @property {number} entry   - fib 0
 * @property {number} sl      - fib -0.27
 * @property {number} tp1     - fib 0.3
 * @property {number} tp2     - fib 0.618
 * @property {number} tpFull  - fib 0.9
 * @property {'bullish'|'bearish'} direction
 */

const RATIOS = {
  entry: 0,
  sl: -0.27,
  tp1: 0.3,
  tp2: 0.618,
  tpFull: 0.9,
};

/**
 * @param {import('./structure').StructureEvent} event
 * @returns {FibLevels}
 */
function computeFibLevels(event) {
  const zero = event.legStart.price; // fib 0 — the OB-side origin
  const one = event.legEnd.price; // fib 1 — the impulse extreme
  const range = one - zero; // signed: positive for bullish leg, negative for bearish

  // priceAt(ratio) = zero + ratio * (one - zero)
  const priceAt = (ratio) => zero + ratio * range;

  return {
    entry: priceAt(RATIOS.entry),
    sl: priceAt(RATIOS.sl),
    tp1: priceAt(RATIOS.tp1),
    tp2: priceAt(RATIOS.tp2),
    tpFull: priceAt(RATIOS.tpFull),
    direction: event.direction,
  };
}

module.exports = { computeFibLevels, RATIOS };
