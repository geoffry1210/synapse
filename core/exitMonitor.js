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
    await router.mirrorClosePercentage(symbol, direction, 30);
    await router.mirrorMoveStopLoss(symbol, trade.entryPrice);
    setupManager.onTradeEvent('tp1_hit', { closedSize, pnl });
  } else if (exitType === 'tp2_hit') {
    const closedSize = trade.remainingSize * 0.3;
    const pnl = realizedPnl(setup.fib.tp2, closedSize);
    await router.mirrorClosePercentage(symbol, direction, 30);
    setupManager.onTradeEvent('tp2_hit', { closedSize, pnl });
  } else if (exitType === 'full_close') {
    const closedSize = trade.remainingSize;
    const pnl = realizedPnl(setup.fib.tpFull, closedSize);
    await router.mirrorClosePercentage(symbol, direction, 100);
    setupManager.onTradeEvent('full_close', { reason: 'tp_full_hit', closedSize, pnl });
  } else if (exitType === 'sl_hit') {
    const exitPrice = trade.slMovedToEntry ? trade.entryPrice : trade.sl;
    const closedSize = trade.remainingSize;
    const pnl = realizedPnl(exitPrice, closedSize);
    await router.mirrorClosePercentage(symbol, direction, 100);
    setupManager.onTradeEvent('sl_hit', { reason: trade.slMovedToEntry ? 'breakeven_stop' : 'sl_hit', closedSize, pnl });
  }

  return exitType;
}

module.exports = { checkExit, processExit };
