/**
 * dumpTrader.js
 * -----------------------------------------------------------------------
 * Places an actual short ("dump-short") when the pump/dump scanner flags
 * a symbol with high dump probability. Purely the ENTRY side — exit
 * management (SL / TP1 2RR / TP2-on-reversal) lives in
 * dumpExitMonitor.js, wired together with this in main.js.
 *
 * One active dump-short per symbol at a time. Deliberately NOT built on
 * core/setupManager.js — that class's Postgres persistence
 * (journal.js's createSetup) is tightly coupled to the SMC order-block
 * schema (ob_low/ob_high columns), which doesn't apply to a
 * probability-triggered short with no order block at all. This is a
 * separate, simpler state machine, scoped to what a dump-short actually
 * needs.
 *
 * Fib math (see core/fibonacci.js's convention: fib 0 = origin, fib 1 =
 * the extreme, negative ratios extend beyond the origin — same formula,
 * applied to the pump's own impulse leg instead of an SMC structure
 * event):
 *   peakPrice (fib 0, entry) = current market price, NOT the pump
 *     candle's historical high — same "real price, not a stale
 *     reference" lesson as the main engine's entry-sizing fix.
 *   originLow (fib 1)        = alert.pumpLow — the pre-pump low the
 *     scanner already computes (see pumpDetector.js's checkLatestPump,
 *     threaded through in scanner.js's scanMarket).
 *   sl  = peakPrice + (-0.4) * (originLow - peakPrice)
 *       — 40% of the leg beyond the peak; above entry, correct side for
 *         a short's stop.
 *   R   = sl - peakPrice
 *   tp1 = peakPrice - 2 * R   — 2RR target; dumpExitMonitor.js closes
 *       50% of size here. TP2 has no fixed price — it closes the
 *       remainder when reversalProbability.js's score crosses the same
 *       threshold used for entry.
 * -----------------------------------------------------------------------
 */

const DEFAULT_DUMP_PROBABILITY_THRESHOLD = 70;

class DumpTradeManager {
  /**
   * @param {{ dumpProbabilityThreshold?: number }} [opts]
   */
  constructor(opts = {}) {
    this.threshold = opts.dumpProbabilityThreshold ?? DEFAULT_DUMP_PROBABILITY_THRESHOLD;
    this.trades = new Map(); // symbol -> trade state
  }

  /** @returns {boolean} whether this symbol currently has an open dump-short */
  hasOpenTrade(symbol) {
    return this.trades.has(symbol);
  }

  /** @returns {object|undefined} */
  getTrade(symbol) {
    return this.trades.get(symbol);
  }

  /** Called by dumpExitMonitor.js once a trade fully closes (TP2 or SL). */
  removeTrade(symbol) {
    this.trades.delete(symbol);
  }

  /**
   * @param {import('./scanner').PumpAlert & { pumpLow: number }} alert
   * @param {import('../core/swings').Candle[]} candles - same candles the
   *   scan cycle already fetched for this symbol (oldest to newest)
   * @param {{
   *   router: import('../execution/executionRouter').ExecutionRouter,
   *   tradeLimiter: import('../core/tradeLimiter').TradeLimiter,
   *   control?: { entriesAllowed: () => boolean },
   *   telegramBot?: import('../telegram/bot').TradingBot,
   * }} deps
   * @returns {Promise<{ entered: boolean, reason?: string }>}
   */
  async maybeEnter(alert, candles, deps) {
    const { router, tradeLimiter, control, telegramBot } = deps;
    const symbol = alert.symbol;

    if (this.hasOpenTrade(symbol)) {
      return { entered: false, reason: 'already_open' };
    }
    if (alert.dumpProbability < this.threshold) {
      return { entered: false, reason: 'below_threshold' };
    }
    if (!candles || candles.length === 0) {
      console.warn(`[dump] ${symbol}: no candles available, skipping entry`);
      return { entered: false, reason: 'no_candles' };
    }
    if (alert.pumpLow == null) {
      console.warn(`[dump] ${symbol}: alert missing pumpLow — scanner.js not passing it through?`);
      return { entered: false, reason: 'missing_pump_low' };
    }

    // No execution adapter for this alert's venue — mirrorEntry() would
    // just fail on every venue (Promise.allSettled swallows each into a
    // { success: false }), which would otherwise look like a confusing
    // silent no-op. In practice most scanner alerts are on weex, which
    // typically isn't a configured execution adapter in BYBIT_DEMO mode
    // (bybit-only) — check up front so the reason is visible.
    if (!router.adapters[alert.venue]) {
      const msg = `${symbol}: dump probability ${alert.dumpProbability}% on ${alert.venue}, but no execution adapter is configured for ${alert.venue} — would have shorted, cannot execute.`;
      console.warn(`[dump] ${msg}`);
      if (telegramBot) telegramBot.notify(`⚠️ ${msg}`).catch(() => {});
      return { entered: false, reason: 'venue_not_tradeable' };
    }

    const peakPrice = candles[candles.length - 1].close;
    const originLow = alert.pumpLow;
    const range = originLow - peakPrice; // negative for a real pump (low sits below the current peak)

    if (!(range < 0) || !(peakPrice > 0) || !(originLow > 0)) {
      console.warn(`[dump] ${symbol}: pump geometry looks wrong (peak=${peakPrice}, low=${originLow}), skipping entry`);
      return { entered: false, reason: 'invalid_geometry' };
    }

    const sl = peakPrice + -0.4 * range;
    const riskDistance = sl - peakPrice; // "R" — always positive given the geometry check above
    const tp1 = peakPrice - 2 * riskDistance;

    if (!(sl > peakPrice && peakPrice > tp1 && riskDistance > 0)) {
      console.warn(`[dump] ${symbol}: computed levels out of order (sl=${sl}, entry=${peakPrice}, tp1=${tp1}), skipping entry`);
      return { entered: false, reason: 'invalid_levels' };
    }

    if (control && !control.entriesAllowed()) {
      return { entered: false, reason: 'control_paused' };
    }

    const { allowed, tradesThisWeek, limit } = await tradeLimiter.canOpenNewTrade();
    if (!allowed) {
      if (telegramBot) {
        await telegramBot
          .notify(`🚫 Dump probability hit on ${symbol} (${alert.dumpProbability}%) but weekly trade limit reached (${tradesThisWeek}/${limit}) — entry skipped.`)
          .catch(() => {});
      }
      return { entered: false, reason: 'weekly_limit' };
    }

    // tp2/tpFull are placeholders (mirrorEntry only reads .entry/.sl for
    // sizing) — dump-shorts don't use a fixed-price TP2, see dumpExitMonitor.js.
    const fib = { entry: peakPrice, sl, tp1, tp2: peakPrice, tpFull: peakPrice };
    const results = await router.mirrorEntry(symbol, 'bearish', fib, peakPrice);
    const successful = Object.values(results).filter((res) => res.success);

    if (successful.length === 0) {
      const errors = Object.entries(results).map(([venue, res]) => `${venue}: ${res.error}`).join('; ');
      console.warn(`[dump] ${symbol}: entry failed on all venues — ${errors}`);
      return { entered: false, reason: 'entry_failed' };
    }

    const totalSize = successful.reduce((sum, res) => sum + (res.size ?? 0), 0);
    const weightedEntry = totalSize > 0
      ? successful.reduce((sum, res) => sum + (res.fillPrice ?? peakPrice) * (res.size ?? 0), 0) / totalSize
      : peakPrice;

    const trade = {
      symbol,
      venue: alert.venue,
      direction: 'bearish',
      entryPrice: weightedEntry,
      sl,
      tp1,
      size: totalSize,
      remainingSize: totalSize,
      tp1Hit: false,
      slMovedToEntry: false,
      realizedPnl: 0,
      openedAt: Date.now(),
      dumpProbabilityAtEntry: alert.dumpProbability,
    };
    this.trades.set(symbol, trade);

    console.log(
      `[dump] ${symbol} trade_entered`,
      JSON.stringify({ entryPrice: weightedEntry, sl, tp1, size: totalSize, dumpProbability: alert.dumpProbability })
    );
    if (telegramBot) {
      await telegramBot
        .notify(
          `📉 Dump-short opened on ${symbol} (${alert.venue})\n` +
          `Dump probability: ${alert.dumpProbability}%\n` +
          `Entry: ${weightedEntry}\nSL: ${sl}\nTP1 (2RR, 50%): ${tp1}\n` +
          `TP2: closes remaining size when a reversal is spotted.`
        )
        .catch(() => {});
    }

    return { entered: true };
  }
}

module.exports = { DumpTradeManager, DEFAULT_DUMP_PROBABILITY_THRESHOLD };
