/**
 * dumpProbability.js
 * -----------------------------------------------------------------------
 * Combines several well-documented reversal/exhaustion signals into a
 * single weighted "dump probability" score (0-100) for a pair that has
 * just been flagged by the pump detector. This is advisory only — it
 * never places a trade, it just scores the setup so you can decide.
 *
 * Signals & weights (of 100 total when all data is available):
 *   - RSI/StochRSI overbought + bearish divergence ......... 25
 *   - Volume climax (spike then fading) .................... 20
 *   - Distance from VWAP (overextension) ................... 20
 *   - Wick rejection pattern clustering ..................... 15
 *   - Funding rate / open interest (if provided) ........... 20
 *
 * If funding/OI data isn't available (not every venue exposes it easily,
 * and spot pairs don't have funding at all), the score is renormalized
 * over the remaining signals rather than silently capped at 80.
 * -----------------------------------------------------------------------
 */

const { computeRSI, rsiSupportsDirection } = require('../indicators/rsi');
const { computeStochRSI, stochRsiSupportsDirection } = require('../indicators/stochRsi');
const { computeVWAP } = require('../indicators/vwap');
const { detectDivergence } = require('../indicators/divergence');
const { isShootingStar, isBearishEngulfing } = require('../indicators/candlePattern');

const WEIGHTS = {
  rsiStochDivergence: 25,
  volumeClimax: 20,
  vwapDistance: 20,
  wickRejection: 15,
  fundingOI: 20,
};

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

function rsiStochScore(candles, index) {
  const rsi = computeRSI(candles);
  const stoch = computeStochRSI(candles);

  const rsiOB = rsiSupportsDirection(rsi[index], 'bearish'); // >70
  const stochOB = stochRsiSupportsDirection(stoch.k[index], 'bearish'); // >80
  const divergence = detectDivergence(candles.slice(0, index + 1), rsi, 2).bearish;

  let score = 0;
  if (rsiOB) score += 0.35;
  if (stochOB) score += 0.25;
  if (divergence) score += 0.4;

  return clamp01(score);
}

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

  const climaxRatio = candles[peakIdx].volume / avgBaselineVol; // how big was the spike
  const decliningFactor =
    index > peakIdx ? clamp01((candles[peakIdx].volume - candles[index].volume) / candles[peakIdx].volume) : 0;

  const climaxScore = clamp01(climaxRatio / 5); // 5x avg volume = full score
  return clamp01(climaxScore * 0.6 + decliningFactor * 0.4);
}

function vwapDistanceScore(candles, index, vwapSeries) {
  const vwap = vwapSeries[index];
  if (vwap === null || vwap === 0) return 0;
  const distance = (candles[index].close - vwap) / vwap;
  if (distance <= 0) return 0; // only scores overextension to the upside
  return clamp01(distance / 0.15); // 15%+ above VWAP = full score
}

function wickRejectionScore(candles, index, lookback = 5) {
  const start = Math.max(1, index - lookback + 1);
  let hits = 0;
  let total = 0;

  for (let i = start; i <= index; i++) {
    total++;
    if (isShootingStar(candles[i]) || isBearishEngulfing(candles[i - 1], candles[i])) hits++;
  }

  return total === 0 ? 0 : clamp01(hits / total);
}

function fundingOIScore({ fundingRate, openInterestChangePct } = {}) {
  if (fundingRate === undefined && openInterestChangePct === undefined) return null; // not available

  let score = 0;
  let parts = 0;

  if (fundingRate !== undefined) {
    // Positive funding = longs paying shorts = crowded long positioning.
    // ~0.05%+ per 8h is already elevated; treat 0.1% as "full score" territory.
    score += clamp01(fundingRate / 0.001);
    parts++;
  }
  if (openInterestChangePct !== undefined) {
    // OI climbing alongside a price pump = fresh leveraged longs piling in.
    score += clamp01(openInterestChangePct / 30); // +30% OI growth = full score
    parts++;
  }

  return parts === 0 ? null : clamp01(score / parts);
}

/**
 * @param {import('../core/swings').Candle[]} candles
 * @param {number} index - the candle to score (typically the latest one, right after a pump flag)
 * @param {{ fundingRate?: number, openInterestChangePct?: number }} derivativesData
 * @returns {{ score: number, breakdown: Record<string, number|null> }}
 */
function computeDumpProbability(candles, index, derivativesData = {}) {
  const vwapSeries = computeVWAP(candles);

  const breakdown = {
    rsiStochDivergence: rsiStochScore(candles, index),
    volumeClimax: volumeClimaxScore(candles, index),
    vwapDistance: vwapDistanceScore(candles, index, vwapSeries),
    wickRejection: wickRejectionScore(candles, index),
    fundingOI: fundingOIScore(derivativesData),
  };

  let weightedSum = 0;
  let totalWeight = 0;

  for (const [key, value] of Object.entries(breakdown)) {
    if (value === null) continue; // skip unavailable signals rather than penalizing
    weightedSum += value * WEIGHTS[key];
    totalWeight += WEIGHTS[key];
  }

  const score = totalWeight === 0 ? 0 : Math.round((weightedSum / totalWeight) * 100);

  return { score, breakdown };
}

module.exports = { computeDumpProbability, WEIGHTS };
