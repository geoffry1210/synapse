/**
 * engineCycle.js
 * -----------------------------------------------------------------------
 * The complete per-symbol pipeline for one "tick" (new candle close):
 *   structure -> setup override -> zone entry -> confluence -> entry ->
 *   exit monitoring -> journal sync -> Telegram notify
 *
 * Factored out from main.js so it can be integration-tested against
 * mocked dependencies (dry-run adapters, mock pool, synthetic candles)
 * without needing real exchange/Telegram/DB connections — see
 * demo-main.js. main.js just wires real dependencies and calls this on
 * an interval per whitelisted symbol.
 * -----------------------------------------------------------------------
 */

const { detectStructure } = require('./structure');
const { computeFibLevels } = require('./fibonacci');
const { precomputeCipherB, reportCipherBFlags } = require('../confluence/cipherB');
const { precomputeOptional, reportOptionalFlags, computeFRVPForSetup } = require('../confluence/optional');
const { processExit } = require('./exitMonitor');

/**
 * @typedef {Object} CycleDeps
 * @property {import('./setupManager').SetupManager} setupManager
 * @property {import('../execution/executionRouter').ExecutionRouter} router
 * @property {import('../journal/journal').Journal} journal
 * @property {import('./tradeLimiter').TradeLimiter} tradeLimiter
 * @property {import('../telegram/bot').TradingBot} [telegramBot] - optional; skipped if not provided
 * @property {string} venueLabel - label passed to journal.syncLog (e.g. "multi" for mirrored execution)
 */

/**
 * Run one full pipeline pass for a symbol given its latest candle history.
 *
 * @param {import('./swings').Candle[]} candles - full history, oldest to newest
 * @param {CycleDeps} deps
 * @param {{ structureLookback?: number }} opts
 */
async function runSymbolCycle(candles, deps, opts = {}) {
  const { setupManager, router, journal, tradeLimiter, telegramBot, venueLabel } = deps;
  const lookback = opts.structureLookback ?? 3;
  const latestIndex = candles.length - 1;
  const latestCandle = candles[latestIndex];

  // 1. Structure detection. Structure events are confirmed with a lag
  //    (a swing needs future candles before it's recognized as a swing
  //    at all), so a newly-confirmed event's breakIndex can be well
  //    behind the latest candle — track what's already been processed
  //    rather than comparing to latestIndex.
  const events = detectStructure(candles, lookback);
  let newEvents;
  if (setupManager.lastProcessedBreakIndex === -1 && events.length > 0) {
    // Cold start (fresh SetupManager, e.g. right after a deploy/restart):
    // detectStructure() correctly returns the FULL historical sequence of
    // every BOS/CHoCH in the fetched candle window (often dozens across a
    // 200-candle history) — treating all of that as "new" replayed every
    // past setup/cancellation as if it just happened, firing a burst of
    // notifications for ancient history instead of reacting to where the
    // market actually stands right now. Jump straight to the single most
    // recent event instead; only genuinely new events from this point
    // forward get processed incrementally.
    newEvents = [events[events.length - 1]];
  } else {
    newEvents = events.filter((e) => e.breakIndex > setupManager.lastProcessedBreakIndex);
  }
  for (const event of newEvents) {
    setupManager.onStructureEvent(candles, event, computeFibLevels(event));
    setupManager.lastProcessedBreakIndex = event.breakIndex;
  }

  // 2. OB invalidation + zone entry check for whatever setup is active.
  setupManager.onPriceUpdate(latestCandle, latestIndex);

  const setup = setupManager.activeSetup;

  // 3. Confluence checking, only while waiting.
  if (setup && setup.status === 'IN_ZONE_AWAITING_CONFLUENCE') {
    const cipherBData = precomputeCipherB(candles);
    const optionalData = precomputeOptional(candles);
    const frvp = computeFRVPForSetup(candles, setup.sourceEvent);

    reportCipherBFlags(setupManager, latestCandle, latestIndex, cipherBData);
    reportOptionalFlags(setupManager, candles, latestIndex, optionalData, frvp);

    if (setupManager.hasFullConfluence()) {
      const { allowed, tradesThisWeek, limit } = await tradeLimiter.canOpenNewTrade();

      if (allowed) {
        const results = await router.mirrorEntry(setupManager.symbol, setup.direction, setup.fib);
        // Use the fib entry as the recorded entry price (mirrors across
        // venues may fill at slightly different prices; fib.entry is the
        // reference the whole system reasons about).
        const anySucceeded = Object.values(results).some((r) => r.success);
        if (anySucceeded) {
          setupManager.enterTrade(setup.fib.entry, 1); // size is per-venue internally; this is a nominal reference size
        }
      } else if (telegramBot) {
        await telegramBot.notify(
          `🚫 Confluence hit on ${setupManager.symbol} but weekly trade limit reached (${tradesThisWeek}/${limit}) — entry skipped.`
        );
      }
    }
  }

  // 4. Exit monitoring for open trades.
  if (setup && (setup.status === 'IN_TRADE' || setup.status === 'MANAGING_EXITS')) {
    await processExit(setupManager, router, latestCandle);
  }

  // 5. Persist + notify.
  await journal.syncLog(setupManager, venueLabel);
  if (telegramBot) await telegramBot.notifyFromEngine(setupManager, candles);
}

module.exports = { runSymbolCycle };
