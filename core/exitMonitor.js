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

/**
 * Convenience: run checkExit and, if something fired, mirror the
 * appropriate close through the execution router and update the
 * SetupManager's state — the full wiring in one call for the main loop.
 *
 * @param {import('./setupManager').SetupManager} setupManager
 * @param {import('../execution/executionRouter').ExecutionRouter} router
 * @param {import('./swings').Candle} candle
 */
async function processExit(setupManager, router, candle) {
  const setup = setupManager.activeSetup;
  const exitType = checkExit(setup, candle);
  if (!exitType) return null;

  const symbol = setupManager.symbol;
  const direction = setup.direction;

  if (exitType === 'tp1_hit') {
    await router.mirrorClosePercentage(symbol, direction, 30);
    await router.mirrorMoveStopLoss(symbol, setup.trade.entryPrice);
    setupManager.onTradeEvent('tp1_hit', {});
  } else if (exitType === 'tp2_hit') {
    await router.mirrorClosePercentage(symbol, direction, 30);
    setupManager.onTradeEvent('tp2_hit', {});
  } else if (exitType === 'full_close') {
    await router.mirrorClosePercentage(symbol, direction, 100);
    setupManager.onTradeEvent('full_close', { reason: 'tp_full_hit' });
  } else if (exitType === 'sl_hit') {
    await router.mirrorClosePercentage(symbol, direction, 100);
    setupManager.onTradeEvent('sl_hit', { reason: setup.trade.slMovedToEntry ? 'breakeven_stop' : 'sl_hit' });
  }

  return exitType;
}

module.exports = { checkExit, processExit };
