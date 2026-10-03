/**
 * exitMonitor.js
 * -----------------------------------------------------------------------
 * Given an active trade (on a SetupManager's activeSetup) and the latest
 * candle, decides whether SL, TP1, TP2, or full TP has been hit. This is
 * the missing link between "a trade is open" and "the execution router
 * actually closes/adjusts it" — call this every candle for any symbol
 * with status IN_TRADE or MANAGING_EXITS.
 *
 * Checks SL first (before TPs) on the theory that if a single candle's
 * range spans both, protecting capital takes priority over locking gains
 * — worth revisiting if you'd rather assume the more favorable outcome
 * instead.
 * -----------------------------------------------------------------------
 */

/**
 * @param {import('./setupManager').SetupManager['activeSetup']} setup
 * @param {import('./swings').Candle} candle
 * @returns {'sl_hit'|'tp1_hit'|'tp2_hit'|'full_close'|null}
 */
function checkExit(setup, candle) {
  if (!setup || !setup.trade) return null;
  const { trade, direction } = setup;

  const currentSL = trade.slMovedToEntry ? trade.entryPrice : trade.sl;

  const slHit = direction === 'bullish' ? candle.low <= currentSL : candle.high >= currentSL;
  if (slHit) return 'sl_hit';

  if (!trade.tp1Hit) {
    const tp1Hit = direction === 'bullish' ? candle.high >= setup.fib.tp1 : candle.low <= setup.fib.tp1;
    if (tp1Hit) return 'tp1_hit';
    return null; // don't check later TPs before earlier ones have fired
  }

  if (!trade.tp2Hit) {
    const tp2Hit = direction === 'bullish' ? candle.high >= setup.fib.tp2 : candle.low <= setup.fib.tp2;
    if (tp2Hit) return 'tp2_hit';
    return null;
  }

  const fullHit = direction === 'bullish' ? candle.high >= setup.fib.tpFull : candle.low <= setup.fib.tpFull;
  if (fullHit) return 'full_close';

  return null;
}

/** @returns {boolean} whether at least one venue reported success */
function anySucceeded(results) {
  return Object.values(results).some((r) => r.success);
}

/** Formats the failed venues out of a router result object for logging/notifying. */
function describeFailures(results) {
  return Object.entries(results)
    .filter(([, r]) => !r.success)
    .map(([venue, r]) => `${venue}: ${r.error}`)
    .join('; ');
}

function reportExitFailure(symbol, action, results, telegramBot) {
  const msg = `${symbol}: ${action} failed on every venue — ${describeFailures(results)}. Local state left unchanged so this is retried next tick.`;
  console.error(`[exit] ${msg}`);
  if (telegramBot) telegramBot.notify(`🚨 ${msg}`).catch(() => {});
}

/**
 * Convenience: run checkExit and, if something fired, mirror the
 * appropriate close through the execution router and update the
 * SetupManager's state — the full wiring in one call for the main loop.
 *
 * Every router call's result is checked before any local state update.
 * If every venue rejects a close/stop-move, the bot's own records are
 * left exactly as they were (not marked closed) so the same exit gets
 * re-attempted on the next tick — previously the local state was updated
 * unconditionally regardless of whether the exchange actually acted,
 * which could leave a real position open and silently unmanaged while
 * the bot believed it was closed.
 *
 * Note on multi-venue mirroring: "success" here means AT LEAST ONE
 * configured venue confirmed the action (matching the same threshold
 * dashboardServer.js's manual-close action already uses) — the bot's
 * internal `trade` object isn't tracked per-venue, so a partial failure
 * across venues still proceeds locally, with the failure logged/notified
 * rather than silently dropped. Fully solving that would mean tracking
 * trade state per-venue, a bigger change than this fix.
 *
 * @param {import('./setupManager').SetupManager} setupManager
 * @param {import('../execution/executionRouter').ExecutionRouter} router
 * @param {import('./swings').Candle} candle
 * @param {import('../telegram/bot').TradingBot} [telegramBot] - optional; used only to notify on a failed exit action
 */
async function processExit(setupManager, router, candle, telegramBot) {
  const setup = setupManager.activeSetup;
  const exitType = checkExit(setup, candle);
  if (!exitType) return null;

  const symbol = setupManager.symbol;
  const direction = setup.direction;
  const dir = direction === 'bullish' ? 1 : -1;
  const trade = setup.trade;

  // P&L uses the trigger LEVEL the bot acted on (the target/stop price
  // itself), not the candle's close — closer to what a market order at
  // that trigger actually fills near. Adapters don't currently report an
  // exact fill price on a close (see closePercentage in ccxtAdapter.js),
  // so this remains an approximation; still far better than recording
  // null, which was the previous behavior for every single exit.
  const realizedPnl = (exitPrice, closedSize) => (exitPrice - trade.entryPrice) * closedSize * dir;

  if (exitType === 'tp1_hit') {
    const closedSize = trade.size * 0.3;
    const pnl = realizedPnl(setup.fib.tp1, closedSize);
    const closeResults = await router.mirrorClosePercentage(symbol, direction, 30);
    if (!anySucceeded(closeResults)) {
      reportExitFailure(symbol, 'TP1 close', closeResults, telegramBot);
      return null;
    }
    const slResults = await router.mirrorMoveStopLoss(symbol, trade.entryPrice);
    const slMoved = anySucceeded(slResults);
    // Non-fatal if the stop-move fails: the 30% close above already
    // happened for real, so local state must reflect that regardless.
    // slMoved=false just means checkExit keeps protecting against the
    // ORIGINAL stop instead of breakeven — still valid protection, not
    // "nothing happened."
    if (!slMoved) reportExitFailure(symbol, 'TP1 stop-move to breakeven', slResults, telegramBot);
    setupManager.onTradeEvent('tp1_hit', { closedSize, pnl, slMoved });
  } else if (exitType === 'tp2_hit') {
    const closedSize = trade.remainingSize * 0.3;
    const pnl = realizedPnl(setup.fib.tp2, closedSize);
    const results = await router.mirrorClosePercentage(symbol, direction, 30);
    if (!anySucceeded(results)) {
      reportExitFailure(symbol, 'TP2 close', results, telegramBot);
      return null;
    }
    setupManager.onTradeEvent('tp2_hit', { closedSize, pnl });
  } else if (exitType === 'full_close') {
    const closedSize = trade.remainingSize;
    const pnl = realizedPnl(setup.fib.tpFull, closedSize);
    const results = await router.mirrorClosePercentage(symbol, direction, 100);
    if (!anySucceeded(results)) {
      reportExitFailure(symbol, 'full-TP close', results, telegramBot);
      return null;
    }
    setupManager.onTradeEvent('full_close', { reason: 'tp_full_hit', closedSize, pnl });
  } else if (exitType === 'sl_hit') {
    const exitPrice = trade.slMovedToEntry ? trade.entryPrice : trade.sl;
    const closedSize = trade.remainingSize;
    const pnl = realizedPnl(exitPrice, closedSize);
    const results = await router.mirrorClosePercentage(symbol, direction, 100);
    if (!anySucceeded(results)) {
      reportExitFailure(symbol, 'SL close', results, telegramBot);
      return null;
    }
    setupManager.onTradeEvent('sl_hit', { reason: trade.slMovedToEntry ? 'breakeven_stop' : 'sl_hit', closedSize, pnl });
  }

  return exitType;
}

/**
 * Force-closes whatever remains of the active setup's LIVE position
 * (100%) because a new structure event is about to supersede it.
 * Call this from engineCycle.js BEFORE letting setupManager.onStructureEvent
 * transition local state — that method only updates local bookkeeping
 * and has no way to touch the router, so without this, a real open
 * position got abandoned (marked closed in our own records while
 * remaining open on the exchange with only its original stop, invisible
 * to the bot from that point on) every time an opposing or newer
 * structure event appeared mid-trade.
 *
 * Returns false (and leaves all state untouched) if every venue rejects
 * the close — the caller is expected to skip processing the new
 * structure event for this tick in that case, rather than abandoning the
 * still-open trade. setupManager.activeSetup.status staying IN_TRADE/
 * MANAGING_EXITS means exitMonitor.js keeps managing it normally on
 * subsequent ticks via its own SL/TP checks either way.
 *
 * @param {import('./setupManager').SetupManager} setupManager
 * @param {import('../execution/executionRouter').ExecutionRouter} router
 * @param {number} exitPrice - current market price (e.g. latestCandle.close)
 *   to use for the P&L estimate — there's no specific SL/TP trigger level
 *   here since this is an off-schedule forced close, not a hit target.
 * @param {import('../telegram/bot').TradingBot} [telegramBot]
 * @returns {Promise<boolean>}
 */
async function closeForSupersede(setupManager, router, exitPrice, telegramBot) {
  const setup = setupManager.activeSetup;
  const symbol = setupManager.symbol;
  const direction = setup.direction;
  const dir = direction === 'bullish' ? 1 : -1;
  const trade = setup.trade;

  const results = await router.mirrorClosePercentage(symbol, direction, 100);
  if (!anySucceeded(results)) {
    reportExitFailure(symbol, 'close-for-supersede', results, telegramBot);
    return false;
  }

  const failures = describeFailures(results);
  if (failures) {
    const msg = `${symbol}: close-for-supersede partially failed (at least one venue succeeded, proceeding) — ${failures}`;
    console.warn(`[exit] ${msg}`);
    if (telegramBot) telegramBot.notify(`⚠️ ${msg}`).catch(() => {});
  }

  const closedSize = trade.remainingSize;
  const pnl = (exitPrice - trade.entryPrice) * closedSize * dir;
  setupManager.onTradeEvent('full_close', { reason: 'superseded_forced_close', closedSize, pnl });
  return true;
}

module.exports = { checkExit, processExit, closeForSupersede };
