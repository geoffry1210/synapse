/**
 * reversalProbability.js
 * -----------------------------------------------------------------------
 * Scores how likely price is reversing AGAINST an open trade's direction
 * — used for TP2 on a dump-short ("close the remaining size on reversal
 * spotted" instead of a fixed price target). Mirrors dumpProbability.js's
 * signal set and weights, reusing the same already direction-aware
 * indicator primitives the rest of the codebase uses
 * (rsiSupportsDirection, stochRsiSupportsDirection,
 * candlePatternSupportsDirection, detectDivergence) rather than
 * inventing new signal logic.
 *
 * Deliberately a separate module from dumpProbability.js rather than a
 * generalized version of it — dumpProbability.js is proven, shipped, and
 * scanned every cycle for every symbol; this keeps that code path
 * completely untouched.
 *
 * Today only exercised for bearish trades (dump-shorts) needing a
 * bullish reversal signal, but written direction-generic in case a
 * pump-side (long) strategy reuses it later.
 * -----------------------------------------------------------------------
 */

const { computeRSI, rsiSupportsDirection } = require('../indicators/rsi');
const { computeStochRSI, stochRsiSupportsDirection } = require('../indicators/stochRsi');
const { computeVWAP, vwapSupportsDirection } = require('../indicators/vwap');
const { detectDivergence } = require('../indicators/divergence');
const { candlePatternSupportsDirection } = require('../indicators/candlePattern');

const WEIGHTS = {
  rsiStochDivergence: 25,
  volumeClimax: 20,
  vwapReclaim: 20,
  candlePattern: 15,
  fundingOI: 20,
};

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

/** @param {'bullish'|'bearish'} tradeDirection */
function reversalDirectionOf(tradeDirection) {
  return tradeDirection === 'bearish' ? 'bullish' : 'bearish';
}

function rsiStochScore(candles, index, revDir) {
  const rsi = computeRSI(candles);
  const stoch = computeStochRSI(candles);

  const rsiFlip = rsiSupportsDirection(rsi[index], revDir);
  const stochFlip = stochRsiSupportsDirection(stoch.k[index], revDir);
  const divergence = detectDivergence(candles.slice(0, index + 1), rsi, 2)[revDir];

  let score = 0;
  if (rsiFlip) score += 0.35;
  if (stochFlip) score += 0.25;
  if (divergence) score += 0.4;
  return clamp01(score);
}

// Same spike-then-fade shape as dumpProbability.js's volumeClimaxScore —
// exhaustion volume matters the same way regardless of which direction
// the preceding move was in, so this is identical, not mirrored.
function volumeClimaxScore(candles, index, lookback = 10, baseline = 20) {
  const windowStart = Math.max(0, index - lookback + 1);
  let peakIdx = windowStart;
  for (let i = windowStart; i <= index; i++) {
    if (candles[i].volume > candles[peakIdx].volume) peakIdx = i;
  }

  const baselineStart = Math.max(0, peakIdx - baseline);
  const baselineSlice = candles.slice(baselineStart, peakIdx);
  if (baselineSlice.length === 0) return 0;

  const avgBaselineVol = baselineSlice.reduce((s, c) => s + c.volume, 0) / baselineSlice.length;
  if (avgBaselineVol === 0) return 0;

  const climaxRatio = candles[peakIdx].volume / avgBaselineVol;
  const decliningFactor =
    index > peakIdx ? clamp01((candles[peakIdx].volume - candles[index].volume) / candles[peakIdx].volume) : 0;

  const climaxScore = clamp01(climaxRatio / 5);
  return clamp01(climaxScore * 0.6 + decliningFactor * 0.4);
}

// Binary rather than dumpProbability's graded distance score: "has price
// reclaimed the favorable side of VWAP for the reversal direction" is a
// simpler, more directly-answerable question than "how overextended,"
// and avoids inventing an untested graded heuristic for this side.
function vwapReclaimScore(candles, index, vwapSeries, revDir) {
  const vwap = vwapSeries[index];
  return vwapSupportsDirection(candles[index], vwap, revDir) ? 1 : 0;
}

// Hit-rate over a short lookback, same style as dumpProbability.js's
// wickRejectionScore, using the direction-aware pattern helper (hammer/
// bullish-engulfing for a bullish reversal, shooting-star/bearish-
// engulfing for a bearish one).
function candlePatternScore(candles, index, revDir, lookback = 5) {
  const start = Math.max(1, index - lookback + 1);
  let hits = 0;
  let total = 0;
  for (let i = start; i <= index; i++) {
    total++;
    if (candlePatternSupportsDirection(candles, i, revDir)) hits++;
  }
  return total === 0 ? 0 : clamp01(hits / total);
}

// Mirror of dumpProbability.js's fundingOIScore: for a bullish reversal
// (closing a short), funding turning negative (shorts paying longs — the
// crowd is now leaning short, a classic squeeze setup) and open interest
// declining (shorts covering) both support the reversal.
function fundingOIScore({ fundingRate, openInterestChangePct } = {}, revDir) {
  if (fundingRate === undefined && openInterestChangePct === undefined) return null;

  let score = 0;
  let parts = 0;

  if (fundingRate !== undefined) {
    const supportive = revDir === 'bullish' ? -fundingRate : fundingRate;
    score += clamp01(supportive / 0.001);
    parts++;
  }
  if (openInterestChangePct !== undefined) {
    const supportive = revDir === 'bullish' ? -openInterestChangePct : openInterestChangePct;
    score += clamp01(supportive / 30);
    parts++;
  }

  return parts === 0 ? null : clamp01(score / parts);
}

/**
 * @param {import('../core/swings').Candle[]} candles
 * @param {number} index - the candle to score (typically the latest one)
 * @param {'bullish'|'bearish'} tradeDirection - the OPEN trade's direction;
 *   this scores the probability of a reversal AGAINST it.
 * @param {{ fundingRate?: number, openInterestChangePct?: number }} [derivativesData]
 * @returns {{ score: number, breakdown: Record<string, number|null>, reversalDirection: 'bullish'|'bearish' }}
 */
function computeReversalProbability(candles, index, tradeDirection, derivativesData = {}) {
  const revDir = reversalDirectionOf(tradeDirection);
  const vwapSeries = computeVWAP(candles);

  const breakdown = {
    rsiStochDivergence: rsiStochScore(candles, index, revDir),
    volumeClimax: volumeClimaxScore(candles, index),
    vwapReclaim: vwapReclaimScore(candles, index, vwapSeries, revDir),
    candlePattern: candlePatternScore(candles, index, revDir),
    fundingOI: fundingOIScore(derivativesData, revDir),
  };

  let weightedSum = 0;
  let totalWeight = 0;
  for (const [key, value] of Object.entries(breakdown)) {
    if (value === null) continue;
    weightedSum += value * WEIGHTS[key];
    totalWeight += WEIGHTS[key];
  }

  const score = totalWeight === 0 ? 0 : Math.round((weightedSum / totalWeight) * 100);
  return { score, breakdown, reversalDirection: revDir };
}

module.exports = { computeReversalProbability, WEIGHTS };
