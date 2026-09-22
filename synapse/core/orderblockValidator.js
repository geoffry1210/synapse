/**
 * orderblockValidator.js
 * -----------------------------------------------------------------------
 * Scores an order block candidate (found by orderblock.js's findOrderBlock)
 * against 6 weighted criteria instead of treating "is this a valid OB" as
 * binary. Each criterion contributes ~1/6 of the base score; missing
 * criteria reduce the score rather than disqualifying the OB outright.
 * An optional 7th signal — live order book depth at the OB's price range —
 * adds a bonus on top when available.
 *
 * These are heuristic, tunable implementations of inherently pattern-based
 * ICT/SMC concepts (there's no single universally "correct" algorithmic
 * definition of "inducement," for example) — thresholds are named
 * constants at the top so they're easy to retune against real charts.
 * -----------------------------------------------------------------------
 */

const { findSwings } = require('./swings');

const THRESHOLDS = {
  impulseMultiple: 1.6,       // impulse leg range must be >= this x the ranging-origin's average candle range
  originWindow: 8,             // how many candles before the OB to treat as "the origin" for the ranging check
  originEfficiencyMax: 0.38,   // net displacement / total movement in the origin window must be BELOW this to count as "ranging" (Kaufman-style efficiency ratio)
  sweepLookback: 12,           // how far back to search for the swing point the impulse's origin swept
  inducementLookback: 1,       // small fractal lookback used to find minor (inducement-scale) swings
  inducementWindow: 10,        // how many candles before the OB to search for an inducement swing
  orderBookBonusMax: 15,       // max points (out of 100 total) the order-book-depth bonus can add
};

/**
 * @typedef {Object} OBScoreResult
 * @property {number} score            - 0-100 base score from the 6 criteria
 * @property {number} bonusScore       - 0-orderBookBonusMax, from order book depth (0 if not supplied)
 * @property {number} totalScore       - score + bonusScore, capped at 100
 * @property {Object} criteria         - { key: { pass: boolean, detail: string } } for every criterion checked
 */

/**
 * @param {import('./swings').Candle[]} candles
 * @param {import('./orderblock').OrderBlock} ob
 * @param {import('./structure').StructureEvent} event
 * @param {{ orderBookDepthRatio?: number }} [liveData]
 *   orderBookDepthRatio: optional, e.g. resting size at the OB price band
 *   divided by average resting size elsewhere — > 1 means notably deeper
 *   than average. Omit entirely when order book data isn't available;
 *   the bonus is simply skipped rather than penalizing the score.
 * @returns {OBScoreResult}
 */
function scoreOrderBlock(candles, ob, event, liveData = {}) {
  const criteria = {};

  criteria.impulsiveMove = checkImpulsiveMove(candles, ob, event);
  criteria.rangingOrigin = checkRangingOrigin(candles, ob);
  criteria.obSweepsPriorCandle = checkObSweepsPriorCandle(candles, ob);
  criteria.imbalanceFvg = checkImbalanceFvg(candles, ob);
  criteria.liquiditySweep = checkLiquiditySweep(candles, ob, event);
  criteria.inducement = checkInducement(candles, ob, event);

  const keys = Object.keys(criteria);
  const passedCount = keys.filter((k) => criteria[k].pass).length;
  const score = Math.round((passedCount / keys.length) * 100);

  let bonusScore = 0;
  if (typeof liveData.orderBookDepthRatio === 'number') {
    // Depth ratio of 1 = average, no bonus. Ratio of 2+ = full bonus.
    bonusScore = Math.round(Math.max(0, Math.min(1, liveData.orderBookDepthRatio - 1)) * THRESHOLDS.orderBookBonusMax);
    criteria.orderBookDepth = { pass: bonusScore > 0, detail: `depth ratio ${liveData.orderBookDepthRatio.toFixed(2)}x average` };
  }

  return { score, bonusScore, totalScore: Math.min(100, score + bonusScore), criteria };
}

/** Criterion 1: the impulse leg must be a genuinely significant move, not a marginal break. */
function checkImpulsiveMove(candles, ob, event) {
  const impulseRange = Math.abs(event.legEnd.price - event.legStart.price);
  const originStart = Math.max(0, ob.index - THRESHOLDS.originWindow);
  const originCandles = candles.slice(originStart, ob.index);
  if (originCandles.length === 0) return { pass: false, detail: 'no origin window to compare against' };

  const avgOriginRange = originCandles.reduce((s, c) => s + (c.high - c.low), 0) / originCandles.length;
  const multiple = avgOriginRange === 0 ? Infinity : impulseRange / avgOriginRange;
  const pass = multiple >= THRESHOLDS.impulseMultiple;
  return { pass, detail: `impulse is ${multiple.toFixed(1)}x the origin's avg candle range (need ${THRESHOLDS.impulseMultiple}x)` };
}

/** Criterion 2: the window right before the OB candle should be ranging, not already trending. */
function checkRangingOrigin(candles, ob) {
  const originStart = Math.max(0, ob.index - THRESHOLDS.originWindow);
  const originCandles = candles.slice(originStart, ob.index);
  if (originCandles.length < 3) return { pass: false, detail: 'not enough candles before the OB to judge' };

  const netMove = Math.abs(originCandles[originCandles.length - 1].close - originCandles[0].open);
  const totalMove = originCandles.reduce((s, c) => s + Math.abs(c.close - c.open), 0);
  const efficiency = totalMove === 0 ? 0 : netMove / totalMove;
  const pass = efficiency <= THRESHOLDS.originEfficiencyMax;
  return { pass, detail: `origin efficiency ratio ${efficiency.toFixed(2)} (ranging needs <= ${THRESHOLDS.originEfficiencyMax})` };
}

/** Criterion 3: the OB candle's wick must sweep (trade beyond) the wick of the candle right before it. */
function checkObSweepsPriorCandle(candles, ob) {
  if (ob.index === 0) return { pass: false, detail: 'no prior candle to sweep' };
  const prev = candles[ob.index - 1];
  const pass = ob.direction === 'bullish' ? ob.low < prev.low : ob.high > prev.high;
  return { pass, detail: pass ? 'OB wick swept the prior candle\'s liquidity' : 'OB wick did not clear the prior candle' };
}

/** Criterion 4: a clean FVG/imbalance between the OB candle and the 2nd candle after it (no wick overlap). */
function checkImbalanceFvg(candles, ob) {
  const c1 = candles[ob.index];
  const c3 = candles[ob.index + 2];
  if (!c3) return { pass: false, detail: 'not enough candles after the OB yet' };

  const pass = ob.direction === 'bullish' ? c1.high < c3.low : c1.low > c3.high;
  const gap = ob.direction === 'bullish' ? c3.low - c1.high : c1.low - c3.high;
  return { pass, detail: pass ? `clear gap of ${gap.toFixed(6)}` : 'wicks overlap — no imbalance' };
}

/** Criterion 5: the impulse's origin swept a recognizable earlier swing point (real liquidity, not just noise). */
function checkLiquiditySweep(candles, ob, event) {
  const swingType = event.direction === 'bullish' ? 'low' : 'high';
  const searchStart = Math.max(0, ob.index - THRESHOLDS.sweepLookback);
  const priorSwings = findSwings(candles.slice(searchStart, ob.index), 2)
    .filter((s) => s.type === swingType);

  if (priorSwings.length === 0) return { pass: false, detail: 'no prior swing point found to sweep' };

  const origin = event.legStart.price;
  const referenceLevel = event.direction === 'bullish'
    ? Math.min(...priorSwings.map((s) => s.price))
    : Math.max(...priorSwings.map((s) => s.price));

  const pass = event.direction === 'bullish' ? origin <= referenceLevel : origin >= referenceLevel;
  return { pass, detail: pass ? `origin swept prior ${swingType} at ${referenceLevel.toFixed(6)}` : `origin (${origin.toFixed(6)}) didn't clear prior ${swingType} at ${referenceLevel.toFixed(6)}` };
}

/** Criterion 6: a smaller "inducement" swing between the sweep and the OB that also got taken out first. */
function checkInducement(candles, ob, event) {
  const windowStart = Math.max(0, ob.index - THRESHOLDS.inducementWindow);
  const window = candles.slice(windowStart, ob.index);
  if (window.length < 5) return { pass: false, detail: 'window too short to look for an inducement swing' };

  const minorType = event.direction === 'bullish' ? 'low' : 'high';
  const minorSwings = findSwings(window, THRESHOLDS.inducementLookback).filter((s) => s.type === minorType);
  if (minorSwings.length === 0) return { pass: false, detail: 'no minor swing found in the window' };

  // Did price, after that minor swing formed, later trade beyond it (i.e. the
  // minor pool got taken) before or at the OB candle itself?
  const taken = minorSwings.some((s) => {
    const afterIndex = windowStart + s.index + 1;
    for (let i = afterIndex; i <= ob.index; i++) {
      const c = candles[i];
      if (!c) continue;
      if (event.direction === 'bullish' ? c.low < s.price : c.high > s.price) return true;
    }
    return false;
  });

  return { pass: taken, detail: taken ? 'a minor swing before the OB was swept first (inducement)' : 'no minor swing was taken before the OB formed' };
}

module.exports = {
  scoreOrderBlock,
  THRESHOLDS,
  checkImpulsiveMove,
  checkRangingOrigin,
  checkObSweepsPriorCandle,
  checkImbalanceFvg,
  checkLiquiditySweep,
  checkInducement,
};
