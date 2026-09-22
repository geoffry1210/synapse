/**
 * riskSizing.js
 * -----------------------------------------------------------------------
 * Fixed-fractional position sizing:
 *
 *   riskAmount = balance * (riskPct / 100)
 *   size       = riskAmount / abs(entryPrice - slPrice)
 *
 * NEW: notional cap. With tight stop-losses the formula above can ask for a
 * position far larger than the account can margin (e.g. $10k on a $1k account),
 * which the exchange rejects. Size is now capped so that
 *   size * entryPrice <= balance * maxLeverage * 0.9
 * maxLeverage comes from params.maxLeverage, else the BYBIT_LEVERAGE env var,
 * else no cap (old behaviour). When the cap applies, actual risk is lower than
 * riskPct, never higher.
 *
 * Per-venue vs total-portfolio risk (see earlier notes) is unchanged.
 * -----------------------------------------------------------------------
 */

const DEFAULTS = {
  mode: 'per_venue', // 'per_venue' | 'total_portfolio'
  riskPct: 1,
};
const MARGIN_BUFFER = 0.9;

function computePositionSize(params) {
  const { balance, entryPrice, slPrice, venueCount = 1 } = params;
  const mode = params.mode ?? DEFAULTS.mode;
  const baseRiskPct = params.riskPct ?? DEFAULTS.riskPct;

  const riskPctUsed = mode === 'total_portfolio' ? baseRiskPct / venueCount : baseRiskPct;
  const riskAmount = balance * (riskPctUsed / 100);
  const slDistance = Math.abs(entryPrice - slPrice);

  if (slDistance === 0) {
    throw new Error('Entry and SL price cannot be equal — cannot compute position size');
  }

  let size = riskAmount / slDistance;
  let capped = false;

  const maxLeverage = Number(params.maxLeverage ?? process.env.BYBIT_LEVERAGE ?? 0);
  if (maxLeverage > 0 && entryPrice > 0) {
    const maxSize = (balance * maxLeverage * MARGIN_BUFFER) / entryPrice;
    if (size > maxSize) { size = maxSize; capped = true; }
  }

  return { size, riskAmount: size * slDistance, riskPctUsed, capped };
}

module.exports = { computePositionSize, DEFAULTS };
