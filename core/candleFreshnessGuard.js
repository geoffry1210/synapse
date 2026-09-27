/**
 * candleFreshnessGuard.js
 * -----------------------------------------------------------------------
 * Detects a symbol's candle feed silently going stale — the exchange (or
 * ccxt, or some caching layer in between) keeps returning the same latest
 * candle over and over without ever throwing. That looks IDENTICAL to
 * "the market just hasn't produced anything new," which the rest of the
 * engine can't tell apart from a real, silent failure — this module is
 * the difference.
 *
 * Not about missing/short candle arrays or fetch errors — those already
 * throw and get caught/logged in main.js's tickSymbol. This is about a
 * successful fetch whose newest candle timestamp stops advancing for far
 * longer than the configured timeframe should ever allow.
 * -----------------------------------------------------------------------
 */

/**
 * @param {string} tf - ccxt-style timeframe string, e.g. '1h', '15m', '4h', '1d'
 * @returns {number|null} milliseconds, or null if the format isn't recognized
 */
function timeframeToMs(tf) {
  const m = /^(\d+)(m|h|d|w)$/.exec(String(tf).trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unitMs = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[m[2]];
  return n * unitMs;
}

class CandleFreshnessGuard {
  /**
   * @param {string} timeframe - e.g. '1h', matching the engine's SIGNAL_TIMEFRAME
   * @param {number} [staleAfterMultiples] - alert once the latest candle's
   *   own timestamp hasn't changed for this many timeframe-intervals worth
   *   of wall-clock time. Default 6 (e.g. 6 hours of no new candle on a 1h
   *   feed for a liquid pair, which should never happen normally).
   * @param {(symbol: string, info: { lastCandleTime: number, stuckForMs: number }) => void} [onStale]
   *   Called once per newly-detected stale state — not on every tick while
   *   it remains stale, and re-armed automatically once a new candle
   *   arrives. Defaults to a console.warn; wire in Telegram/dashboard as
   *   needed from the caller.
   */
  constructor(timeframe, staleAfterMultiples = 6, onStale) {
    const tfMs = timeframeToMs(timeframe);
    this.staleAfterMs = (tfMs ?? 3_600_000) * staleAfterMultiples;
    this.onStale = onStale ?? ((symbol, info) => {
      const mins = Math.round(info.stuckForMs / 60_000);
      console.warn(`⚠️  ${symbol}: candle feed appears stuck — latest candle unchanged for ~${mins}m.`);
    });
    this._state = new Map(); // symbol -> { lastCandleTime, firstSeenAt, alerted }
  }

  /**
   * Call once per tick with the freshly-fetched candle history for a
   * symbol (oldest to newest) — cheap, synchronous, no side effects
   * beyond the optional onStale callback.
   *
   * @param {string} symbol
   * @param {{ time: number }[]} candles
   */
  check(symbol, candles) {
    if (!candles || candles.length === 0) return;
    const latestTime = candles[candles.length - 1].time;
    const now = Date.now();
    const prev = this._state.get(symbol);

    if (!prev || prev.lastCandleTime !== latestTime) {
      // New candle arrived (or first time seeing this symbol) — reset.
      this._state.set(symbol, { lastCandleTime: latestTime, firstSeenAt: now, alerted: false });
      return;
    }

    if (prev.alerted) return; // already reported; wait for a new candle to re-arm
    const stuckForMs = now - prev.firstSeenAt;
    if (stuckForMs > this.staleAfterMs) {
      prev.alerted = true;
      this.onStale(symbol, { lastCandleTime: latestTime, stuckForMs });
    }
  }
}

module.exports = { CandleFreshnessGuard, timeframeToMs };
