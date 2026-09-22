/**
 * scanner.js
 * -----------------------------------------------------------------------
 * Orchestrates the pump/dump screener across a market: for each symbol,
 * check the latest candle for a pump flag, and if found, score its dump
 * probability. Purely advisory — this module never places trades, it
 * only produces alerts for Telegram delivery so you can decide manually.
 *
 * Per your rules: scans the WHOLE exchange (not just the majors
 * whitelist), with low-cap coins weighted for priority since they're
 * more prone to whale dumping.
 * -----------------------------------------------------------------------
 */

const { checkLatestPump } = require('./pumpDetector');
const { computeDumpProbability } = require('./dumpProbability');

/**
 * @typedef {Object} SymbolInput
 * @property {import('../core/swings').Candle[]} candles
 * @property {'low'|'mid'|'large'} tier - market cap tier, used for alert priority
 * @property {string} venue - 'bybit' | 'weex' | etc.
 * @property {{ fundingRate?: number, openInterestChangePct?: number }} [derivativesData]
 */

/**
 * @typedef {Object} PumpAlert
 * @property {string} symbol
 * @property {string} venue
 * @property {'low'|'mid'|'large'} tier
 * @property {number} pctGain
 * @property {number} dumpProbability - 0-100
 * @property {Record<string, number|null>} breakdown
 * @property {number} priorityScore - used for sorting (low-cap weighted higher)
 */

// Widened from an earlier 1.3/1.1/1.0 spread, which was too subtle to
// visibly change ranking order between similarly-scored alerts — low-cap
// coins should clearly outrank large-caps at a similar dump-probability
// score, per the "focus more on low-cap" requirement.
const TIER_PRIORITY_WEIGHT = { low: 1.6, mid: 1.2, large: 1.0 };

/**
 * @param {Record<string, SymbolInput>} symbolCandleMap - keyed by symbol, e.g. "PEPEUSDT"
 * @param {{ windowCandles?: number, thresholdPct?: number }} pumpOpts
 * @returns {PumpAlert[]} sorted by priority (low-cap + high dump probability first)
 */
function scanMarket(symbolCandleMap, pumpOpts = {}) {
  const alerts = [];

  for (const [symbol, input] of Object.entries(symbolCandleMap)) {
    const { candles, tier = 'mid', venue, derivativesData } = input;
    if (!candles || candles.length === 0) continue;

    const pump = checkLatestPump(candles, pumpOpts);
    if (!pump) continue;

    const { score, breakdown } = computeDumpProbability(candles, pump.index, derivativesData);
    const tierWeight = TIER_PRIORITY_WEIGHT[tier] ?? 1.0;

    alerts.push({
      symbol,
      venue,
      tier,
      pctGain: Math.round(pump.pctGain * 10) / 10,
      dumpProbability: score,
      breakdown,
      priorityScore: Math.round(score * tierWeight),
    });
  }

  return alerts.sort((a, b) => b.priorityScore - a.priorityScore);
}

/**
 * Format an alert into a Telegram-ready message (plain text; swap in
 * MarkdownV2/HTML formatting once wired into the actual bot).
 * @param {PumpAlert} alert
 */
function formatAlertMessage(alert) {
  const tierLabel = alert.tier === 'low' ? 'LOW-CAP ⚠️' : alert.tier.toUpperCase();
  return (
    `🚨 PUMP DETECTED — ${alert.symbol} (${alert.venue})\n` +
    `Tier: ${tierLabel}\n` +
    `Gain: +${alert.pctGain}% (< 24h)\n` +
    `Dump probability: ${alert.dumpProbability}%\n` +
    `Signals: ${Object.entries(alert.breakdown)
      .filter(([, v]) => v !== null)
      .map(([k, v]) => `${k}=${Math.round(v * 100)}%`)
      .join(', ')}`
  );
}

module.exports = { scanMarket, formatAlertMessage, TIER_PRIORITY_WEIGHT };
