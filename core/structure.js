/**
 * structure.js
 * -----------------------------------------------------------------------
 * Detects Break of Structure (BOS) and Change of Character (CHoCH) events
 * from a zig-zag swing sequence (see swings.js).
 *
 * Definitions used:
 *  - Uptrend  = sequence of Higher Highs (HH) + Higher Lows (HL)
 *  - Downtrend = sequence of Lower Lows (LL) + Lower Highs (LH)
 *  - BOS   = price closes beyond the last swing point *in the direction
 *            of the current trend* -> trend continuation confirmed.
 *  - CHoCH = price closes beyond the last swing point *against* the
 *            current trend -> first sign of a potential reversal.
 *
 * The very first structural break (before any trend bias exists) is
 * always classified as a CHoCH, since it's what establishes the initial
 * bias.
 * -----------------------------------------------------------------------
 */

const { findSwings, toZigZag } = require('./swings');

/**
 * @typedef {Object} StructureEvent
 * @property {'BOS'|'CHoCH'} type
 * @property {'bullish'|'bearish'} direction   - direction of the move that caused the break
 * @property {number} breakIndex               - candle index where the break was confirmed (close beyond level)
 * @property {number} breakPrice               - the close price that confirmed the break
 * @property {Object} brokenSwing              - the swing point that was broken
 * @property {Object} legStart                 - the swing that starts the impulse leg (for fib anchor)
 * @property {Object} legEnd                   - the swing that ends the impulse leg == brokenSwing's opposite extreme
 */

/**
 * Walk through candles + zig-zag swings and emit BOS/CHoCH events in
 * chronological order.
 *
 * @param {import('./swings').Candle[]} candles
 * @param {number} lookback - passed through to findSwings
 * @returns {StructureEvent[]}
 */
function detectStructure(candles, lookback = 3) {
  const zigzag = toZigZag(findSwings(candles, lookback));
  const events = [];

  let trend = null; // 'bullish' | 'bearish' | null (undefined bias)
  // Track the most recent swing high / swing low seen so far.
  let lastHigh = null;
  let lastLow = null;

  for (const swing of zigzag) {
    if (swing.type === 'high') {
      if (lastHigh) {
        checkBreak('high', swing);
      }
      lastHigh = swing;
    } else {
      if (lastLow) {
        checkBreak('low', swing);
      }
      lastLow = swing;
    }
  }

  /**
   * Check candle closes (scanning forward from the swing itself) to see
   * whether price actually closes beyond the relevant prior swing level,
   * and classify the resulting event.
   */
  function checkBreak(newSwingType, newSwing) {
    const priorLevel = newSwingType === 'high' ? lastHigh : lastLow;
    if (!priorLevel) return;

    // Scan candles after the prior swing for the first close that
    // breaks beyond its price level.
    for (let i = priorLevel.index + 1; i < candles.length; i++) {
      const c = candles[i];
      const brokeUp = newSwingType === 'high' && c.close > priorLevel.price;
      const brokeDown = newSwingType === 'low' && c.close < priorLevel.price;

      if (brokeUp || brokeDown) {
        const direction = brokeUp ? 'bullish' : 'bearish';
        let type;

        if (trend === null) {
          type = 'CHoCH'; // establishes initial bias
        } else if (
          (trend === 'bullish' && direction === 'bullish') ||
          (trend === 'bearish' && direction === 'bearish')
        ) {
          type = 'BOS'; // continuation
        } else {
          type = 'CHoCH'; // reversal
        }

        // The impulse leg that produced this break originates at the most
        // recent *opposite*-type swing (the low before a rally, or the
        // high before a decline) — that's the true fib anchor, not the
        // same-type level that just got broken.
        const legOrigin = newSwingType === 'high' ? lastLow : lastHigh;

        events.push({
          type,
          direction,
          breakIndex: i,
          breakPrice: c.close,
          brokenSwing: priorLevel,
          legStart: legOrigin || priorLevel, // fallback if no opposite swing exists yet
          legEnd: newSwing,
        });

        trend = direction;
        break; // only the first break of this level matters
      }
    }
  }

  return events;
}

module.exports = { detectStructure };
