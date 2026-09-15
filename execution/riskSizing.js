/**
 * riskSizing.js
 * -----------------------------------------------------------------------
 * Computes position size from: account balance, % of balance risked per
 * trade, and the distance between entry and SL. Standard fixed-fractional
 * position sizing formula:
 *
 *   riskAmount = balance * (riskPct / 100)
 *   size = riskAmount / abs(entryPrice - slPrice)
 *
 * IMPORTANT — open question flagged earlier and still worth deciding:
 * since the same signal mirrors across Bybit, Weex, MEXC, Bitget, and
 * MT5 simultaneously, using the same riskPct on EACH venue means your
 * real total risk on one signal is ~5x riskPct, not riskPct. This module
 * defaults to `perVenueRiskPct` (simplest, matches how you've described
 * things so far), but also exposes a `totalPortfolioRiskPct` mode that
 * splits one total risk budget evenly across however many venues are
 * actually trading a given signal — worth switching to once you've
 * decided which behavior you actually want.
 * -----------------------------------------------------------------------
 */

const DEFAULTS = {
  mode: 'per_venue', // 'per_venue' | 'total_portfolio'
  riskPct: 1, // 1% of balance per trade (placeholder default — tune to your comfort level)
};

/**
 * @param {Object} params
 * @param {number} params.balance
 * @param {number} params.entryPrice
 * @param {number} params.slPrice
 * @param {number} [params.riskPct] - overrides DEFAULTS.riskPct
 * @param {'per_venue'|'total_portfolio'} [params.mode]
 * @param {number} [params.venueCount] - required for 'total_portfolio' mode
 * @returns {{ size: number, riskAmount: number, riskPctUsed: number }}
 */
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

  const size = riskAmount / slDistance;

  return { size, riskAmount, riskPctUsed };
}

module.exports = { computePositionSize, DEFAULTS };
