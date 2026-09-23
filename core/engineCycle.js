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
const { findOrderBlock } = require('./orderblock');
const { computeHtfBias } = require('./htfBias');
const { scoreOrderBlock } = require('./orderblockValidator');
const { checkLtfConfirmation } = require('./ltfConfirmation');
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
 * @property {{ entriesAllowed: () => boolean }} [control] - bot pause/stop gate
 */

/**
 * Run one full pipeline pass for a symbol given its latest candle history.
 *
 * @param {import('./swings').Candle[]} candles - full history at the OB-search timeframe (2H-30m band), oldest to newest
 * @param {CycleDeps} deps
 * @param {{
 *   structureLookback?: number,
 *   htfCandles?: { daily: import('./swings').Candle[], fourHour: import('./swings').Candle[] },
 *   ltfCandles?: import('./swings').Candle[],
 *   entryModel?: 'aggressive'|'confirmation',
 *   minObScore?: number,
 *   liveData?: { orderBookDepthRatio?: number },
 * }} opts
 *   htfCandles: 1D + 4H candles for the bias filter. Omit to disable HTF
 *   filtering entirely (falls back to the original always-both-directions
 *   behavior).
 *   ltfCandles: lower-timeframe candles for Entry Model 2's confirmation
 *   check. Only consulted when entryModel is 'confirmation'.
 *   entryModel: 'aggressive' (Model 1, default) enters as soon as the OB
 *   zone + confluence gate pass. 'confirmation' (Model 2) additionally
 *   requires a matching LTF CHoCH inside the zone first.
 *   minObScore: 0-100 minimum orderblockValidator score required to even
 *   watch a candidate OB. Defaults to 50 (roughly 3-of-6 criteria).
 *   liveData: passed straight to scoreOrderBlock() for the order-book-depth bonus.
 */
async function runSymbolCycle(candles, deps, opts = {}) {
  const { setupManager, router, journal, tradeLimiter, telegramBot, venueLabel, control } = deps;
  const lookback = opts.structureLookback ?? 3;
  const entryModel = opts.entryModel ?? 'aggressive';
  const minObScore = opts.minObScore ?? 50;
  const latestIndex = candles.length - 1;
  const latestCandle = candles[latestIndex];

  // HTF bias — computed once per tick (not per event) so every event this
  // tick is judged against the same snapshot. Omitted entirely when
  // htfCandles isn't supplied, which fully restores the original
  // trade-both-directions-independently behavior.
  const htfBiasResult = opts.htfCandles ? computeHtfBias(opts.htfCandles.daily, opts.htfCandles.fourHour) : null;

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
    setupManager.lastProcessedBreakIndex = event.breakIndex;

    // HTF bias hard filter: skip entirely while the HTF is ranging (no
    // trend to align with or override), regardless of direction.
    if (htfBiasResult && htfBiasResult.bias === 'ranging') {
      setupManager.emitSkip('htf_ranging', { direction: event.direction, htf: htfBiasResult });
      continue;
    }

    // Score the OB candidate before committing to it. This duplicates
    // findOrderBlock's cheap synchronous scan (onStructureEvent below
    // does its own lookup too) rather than restructuring that method —
    // simplest way to gate on score without touching its internals.
    const ob = findOrderBlock(candles, event);
    if (ob) {
      const scoreResult = scoreOrderBlock(candles, ob, event, opts.liveData ?? {});
      if (scoreResult.totalScore < minObScore) {
        setupManager.emitSkip('ob_score_too_low', { direction: event.direction, obScore: scoreResult.totalScore, criteria: scoreResult.criteria });
        continue;
      }

      const alignsWithBias = htfBiasResult ? event.direction === htfBiasResult.bias : null;
      setupManager.onStructureEvent(candles, event, computeFibLevels(event), { obScore: scoreResult.totalScore, alignsWithBias });
    } else {
      setupManager.onStructureEvent(candles, event, computeFibLevels(event)); // let onStructureEvent's own ob_not_found path handle it
    }
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

    // Entry Model 2 (confirmation): also needs a matching LTF CHoCH inside
    // the zone before the confluence gate is allowed to fire an entry.
    if (entryModel === 'confirmation' && opts.ltfCandles && !setup.ltfConfirmed) {
      const ltfResult = checkLtfConfirmation(opts.ltfCandles, setup, { lookback: opts.ltfLookback ?? 2 });
      if (ltfResult.confirmed) setupManager.onLtfConfirmation();
    }
    const entryModelSatisfied = entryModel !== 'confirmation' || setup.ltfConfirmed;

    if (setupManager.hasFullConfluence() && entryModelSatisfied) {
      const { allowed, tradesThisWeek, limit } = await tradeLimiter.canOpenNewTrade();

      if (control && !control.entriesAllowed()) {
        // bot paused or stopped: keep the setup alive, skip the entry
      } else if (allowed) {
        // Size and validate against the REAL market price, not fib.entry
        // (the original structure-leg price, which can be far from where
        // the bot actually enters once price has moved through the OB
        // zone — this was the root cause of real risk averaging 2x the
        // intended amount, up to 6x, and of firing an instant fake TP1
        // "win" on setups where price had already passed it before entry
        // even happened).
        const referencePrice = latestCandle.close;
        const dir = setup.direction === 'bullish' ? 1 : -1;
        const pastStop = dir === 1 ? referencePrice <= setup.fib.sl : referencePrice >= setup.fib.sl;
        const plannedRoom = (setup.fib.tp1 - setup.fib.entry) * dir;
        const remainingRoom = (setup.fib.tp1 - referencePrice) * dir;
        const roomPct = plannedRoom > 0 ? (remainingRoom / plannedRoom) * 100 : 0;

        if (pastStop || roomPct < 20) {
          setupManager.emitSkip('entry_invalid_at_fill', {
            direction: setup.direction,
            reason: pastStop ? 'price_past_stop' : 'tp1_already_passed',
            referencePrice,
            roomPct: Math.round(roomPct),
          });
        } else {
          const results = await router.mirrorEntry(setupManager.symbol, setup.direction, setup.fib, referencePrice);
          const successful = Object.values(results).filter((r) => r.success);
          if (successful.length > 0) {
            const totalSize = successful.reduce((sum, r) => sum + (r.size ?? 0), 0);
            const weightedEntry = totalSize > 0
              ? successful.reduce((sum, r) => sum + (r.fillPrice ?? referencePrice) * (r.size ?? 0), 0) / totalSize
              : referencePrice;
            setupManager.enterTrade(weightedEntry, totalSize);
          }
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
