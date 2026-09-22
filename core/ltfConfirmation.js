/**
 * ltfConfirmation.js
 * -----------------------------------------------------------------------
 * Entry Model 2 (confirmation entries) requires more than just price
 * sitting in the OB zone with confluence — it also wants a fresh
 * lower-timeframe CHoCH *inside* the zone, in the trade's direction,
 * before firing. This is the classic "wait for the LTF to confirm the
 * reversal before committing" refinement on top of Model 1's more
 * aggressive "enter on first retest" behavior.
 *
 * Model 1 (aggressive) doesn't use this module at all — it's only
 * consulted when the active entry model is 'confirmation'.
 * -----------------------------------------------------------------------
 */

const { detectStructure } = require('./structure');

/**
 * @param {import('./swings').Candle[]} ltfCandles - lower-timeframe candles (e.g. 5m/15m), full history
 * @param {import('./setupManager').SetupManager['activeSetup']} setup - the setup currently awaiting confirmation
 * @param {{ lookback?: number }} opts
 * @returns {{ confirmed: boolean, detail: string }}
 */
function checkLtfConfirmation(ltfCandles, setup, opts = {}) {
  const lookback = opts.lookback ?? 2;
  if (!setup || !setup.zoneEnteredAt) {
    return { confirmed: false, detail: 'setup has not entered its zone yet' };
  }

  // Only look at LTF candles from the moment price entered the OB zone
  // onward — a CHoCH from before that isn't the confirmation we want.
  const windowCandles = ltfCandles.filter((c) => c.time >= setup.zoneEnteredAt);
  if (windowCandles.length < lookback * 2 + 3) {
    return { confirmed: false, detail: 'not enough LTF candles since zone entry yet' };
  }

  const events = detectStructure(windowCandles, lookback);
  const matchingEvent = events.find((e) => e.direction === setup.direction);

  return {
    confirmed: !!matchingEvent,
    detail: matchingEvent
      ? `LTF ${matchingEvent.type} confirmed ${setup.direction} inside the zone`
      : `no matching LTF CHoCH/BOS yet (${events.length} unrelated event(s) seen)`,
  };
}

module.exports = { checkLtfConfirmation };
