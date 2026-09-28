/**
 * dumpExitMonitor.js
 * -----------------------------------------------------------------------
 * Given an open dump-short (from dumpTrader.js's DumpTradeManager) and
 * the latest candles for that symbol, decides whether SL, TP1 (2RR,
 * 50%), or TP2 (remaining 50%, closed on a spotted reversal rather than
 * a fixed price) has fired, and drives the execution router accordingly.
 * Mirrors core/exitMonitor.js's shape and SL-checked-first-before-TPs
 * rationale, adapted for a trade state that isn't a SetupManager's
 * activeSetup and a TP2 that's event-driven, not price-driven.
 *
 * checkDumpExit needs the full candle history (not just the latest
 * candle, unlike core/exitMonitor.js's checkExit) because TP2 requires
 * reversalProbability.js's indicators (RSI, StochRSI, VWAP, divergence),
 * which need history — only computed once TP1 has already fired, so
 * this isn't paying that cost on every check.
 * -----------------------------------------------------------------------
 */

const { computeReversalProbability } = require('./reversalProbability');

const DEFAULT_REVERSAL_THRESHOLD = 70; // mirrors dumpTrader.js's entry threshold

/**
 * @param {import('./dumpTrader').DumpTradeManager['trades'] extends Map<string, infer T> ? T : never} trade
 * @param {import('../core/swings').Candle[]} candles - oldest to newest; must include the latest candle
 * @param {{ reversalThreshold?: number, derivativesData?: object }} [opts]
 * @returns {{ type: 'sl_hit'|'tp1_hit'|'tp2_reversal', score?: number, breakdown?: object }|null}
 */
function checkDumpExit(trade, candles, opts = {}) {
  if (!trade || !candles || candles.length === 0) return null;
  const candle = candles[candles.length - 1];

  // Dump-shorts are always bearish — no direction branching needed here,
  // unlike core/exitMonitor.js which serves both directions.
  const currentSL = trade.slMovedToEntry ? trade.entryPrice : trade.sl;
  if (candle.high >= currentSL) return { type: 'sl_hit' };

  if (!trade.tp1Hit) {
    if (candle.low <= trade.tp1) return { type: 'tp1_hit' };
    return null; // don't evaluate a reversal before TP1 has even fired
  }

  const reversalThreshold = opts.reversalThreshold ?? DEFAULT_REVERSAL_THRESHOLD;
  const { score, breakdown } = computeReversalProbability(
    candles,
    candles.length - 1,
    'bearish',
    opts.derivativesData
  );
  if (score >= reversalThreshold) return { type: 'tp2_reversal', score, breakdown };

  return null;
}

/**
 * Runs checkDumpExit and, if something fired, mirrors the close through
 * the execution router, updates the trade record in place, removes it
 * from dumpTradeManager once fully closed, and notifies Telegram — the
 * full wiring in one call, same pattern as core/exitMonitor.js's
 * processExit.
 *
 * @param {object} trade - from dumpTradeManager.getTrade(symbol)
 * @param {import('../core/swings').Candle[]} candles
 * @param {{
 *   router: import('../execution/executionRouter').ExecutionRouter,
 *   dumpTradeManager: import('./dumpTrader').DumpTradeManager,
 *   telegramBot?: import('../telegram/bot').TradingBot,
 *   reversalThreshold?: number,
 *   derivativesData?: object,
 * }} deps
 * @returns {Promise<'sl_hit'|'tp1_hit'|'tp2_reversal'|null>}
 */
async function processDumpExit(trade, candles, deps) {
  const { router, dumpTradeManager, telegramBot } = deps;
  const exit = checkDumpExit(trade, candles, deps);
  if (!exit) return null;

  const symbol = trade.symbol;
  const candle = candles[candles.length - 1];

  // P&L uses the trigger LEVEL the bot acted on (the target/stop price
  // itself, or the current close for the reversal-driven TP2), not
  // necessarily the exact fill — same approximation rationale as
  // core/exitMonitor.js (adapters don't report an exact fill price on a
  // close). Dump-shorts are always bearish, so profit = entry - exit.
  const realizedPnl = (exitPrice, closedSize) => (trade.entryPrice - exitPrice) * closedSize;

  if (exit.type === 'sl_hit') {
    const exitPrice = trade.slMovedToEntry ? trade.entryPrice : trade.sl;
    const closedSize = trade.remainingSize;
    const pnl = realizedPnl(exitPrice, closedSize);

    await router.mirrorClosePercentage(symbol, 'bearish', 100);
    trade.realizedPnl += pnl;
    trade.remainingSize = 0;

    const reason = trade.slMovedToEntry ? 'breakeven_stop' : 'sl_hit';
    console.log(`[dump] ${symbol} trade_closed`, JSON.stringify({ reason, closedSize, pnl, totalPnl: trade.realizedPnl }));
    if (telegramBot) {
      await telegramBot
        .notify(
          `🛑 Dump-short on ${symbol} stopped out${trade.slMovedToEntry ? ' at breakeven' : ''}. ` +
          `P&L: ${pnl.toFixed(6)} (total: ${trade.realizedPnl.toFixed(6)})`
        )
        .catch(() => {});
    }
    dumpTradeManager.removeTrade(symbol);
    return exit.type;
  }

  if (exit.type === 'tp1_hit') {
    const closedSize = trade.size * 0.5;
    const pnl = realizedPnl(trade.tp1, closedSize);

    await router.mirrorClosePercentage(symbol, 'bearish', 50);
    await router.mirrorMoveStopLoss(symbol, trade.entryPrice);

    trade.tp1Hit = true;
    trade.slMovedToEntry = true;
    trade.remainingSize -= closedSize;
    trade.realizedPnl += pnl;

    console.log(`[dump] ${symbol} trade_tp1_hit`, JSON.stringify({ closedSize, pnl, remainingSize: trade.remainingSize }));
    if (telegramBot) {
      await telegramBot
        .notify(
          `✅ Dump-short TP1 hit on ${symbol} (2RR) — closed 50%. SL moved to breakeven. ` +
          `P&L so far: ${trade.realizedPnl.toFixed(6)}`
        )
        .catch(() => {});
    }
    return exit.type;
  }

  // tp2_reversal
  const exitPrice = candle.close;
  const closedSize = trade.remainingSize;
  const pnl = realizedPnl(exitPrice, closedSize);

  await router.mirrorClosePercentage(symbol, 'bearish', 100);
  trade.realizedPnl += pnl;
  trade.remainingSize = 0;

  console.log(
    `[dump] ${symbol} trade_closed`,
    JSON.stringify({ reason: 'reversal_spotted', reversalScore: exit.score, closedSize, pnl, totalPnl: trade.realizedPnl })
  );
  if (telegramBot) {
    await telegramBot
      .notify(
        `🔄 Reversal spotted on ${symbol} (score ${exit.score}%) — closed remaining position. ` +
        `Total P&L: ${trade.realizedPnl.toFixed(6)}`
      )
      .catch(() => {});
  }
  dumpTradeManager.removeTrade(symbol);
  return exit.type;
}

module.exports = { checkDumpExit, processDumpExit, DEFAULT_REVERSAL_THRESHOLD };
