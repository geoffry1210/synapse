/**
 * orderbookProbability.js
 * -----------------------------------------------------------------------
 * Scores how much live order book depth supports an order block
 * candidate, on top of its structural score from orderblockValidator.js.
 * Feeds into that module's existing (previously unused — see
 * engineCycle.js's integration) orderBookDepthRatio-style bonus, and
 * into engineCycle.js's per-setup aggressive-vs-confirmation entry model
 * decision: a high-probability OB (strong structure AND strong live
 * order book support) gets an aggressive entry; a weaker one needs LTF
 * confirmation first.
 *
 * Every signal comes from a single ccxt fetchOrderBook() snapshot — no
 * persistent order-flow tracking over time (watching whether a wall
 * stays resting or gets pulled). That's a meaningfully bigger
 * undertaking (needs polling + state across ticks) and a reasonable
 * follow-up, not attempted here.
 *
 *   - imbalance: of the resting volume within `bandPct` of the zone,
 *     what fraction sits on the side that would actually defend it —
 *     bids below a bullish OB, asks above a bearish one?
 *   - wall: is there a single price level in that band holding
 *     disproportionately more size than the band's average level — a
 *     classic sign of real resting interest, not noise?
 *   - depthRatio: resting size in the band vs the book's average resting
 *     size per level elsewhere — matches orderblockValidator.js's
 *     original orderBookDepthRatio concept exactly, kept as its own
 *     signal for that reason.
 *   - spread: a wide spread makes the whole snapshot a less reliable
 *     read (and costs more to actually enter on) — a quality discount,
 *     not a directional signal.
 * -----------------------------------------------------------------------
 */

const WEIGHTS = { imbalance: 35, wall: 25, depthRatio: 20, spread: 20 };

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

/**
 * @param {{ bids: [number, number][], asks: [number, number][] }} orderbook - from exchange.fetchOrderBook(symbol)
 * @param {number} zonePrice - the OB price to evaluate around (typically the OB's near boundary / fib.entry)
 * @param {'bullish'|'bearish'} direction
 * @param {{ bandPct?: number }} [opts] - bandPct: how far around zonePrice counts as "near the zone" (default 0.5%)
 * @returns {{ score: number, breakdown: { imbalance: number, wall: number, depthRatio: number, spread: number }, orderBookDepthRatio: number }}
 */
function computeOrderbookProbability(orderbook, zonePrice, direction, opts = {}) {
  const bandPct = opts.bandPct ?? 0.005;
  const lowBound = zonePrice * (1 - bandPct);
  const highBound = zonePrice * (1 + bandPct);

  const bidsInBand = (orderbook.bids ?? []).filter(([price]) => price >= lowBound && price <= highBound);
  const asksInBand = (orderbook.asks ?? []).filter(([price]) => price >= lowBound && price <= highBound);

  const bidVolume = bidsInBand.reduce((s, [, size]) => s + size, 0);
  const askVolume = asksInBand.reduce((s, [, size]) => s + size, 0);
  const totalBandVolume = bidVolume + askVolume;

  // Imbalance: for a bullish OB, bids (buy support) defending the zone is
  // favorable; for a bearish OB, asks (sell resistance) defending it is.
  const favorableVolume = direction === 'bullish' ? bidVolume : askVolume;
  const imbalanceScore = totalBandVolume === 0 ? 0 : clamp01(favorableVolume / totalBandVolume);

  // Wall: does the single biggest level in the band hold much more than
  // the OTHER levels in the band average — not the band average
  // including itself, which would dilute exactly the outlier this is
  // meant to detect. A real resting wall, not just noise.
  const favorableLevels = direction === 'bullish' ? bidsInBand : asksInBand;
  let wallScore = 0;
  if (favorableLevels.length > 0) {
    const sizes = favorableLevels.map(([, size]) => size);
    const maxSize = Math.max(...sizes);
    const sumOthers = sizes.reduce((s, v) => s + v, 0) - maxSize;
    const countOthers = sizes.length - 1;
    const avgOthers = countOthers > 0 ? sumOthers / countOthers : 0;
    wallScore = avgOthers === 0
      ? (maxSize > 0 ? 1 : 0) // only one level, or every other level is empty -> treat the lone big level as a full wall
      : clamp01((maxSize / avgOthers - 1) / 4); // full score at >=5x the OTHER levels' average
  }

  // Depth ratio: favorable resting size in the band vs the whole book's
  // average resting size per level, elsewhere — the original
  // orderBookDepthRatio concept from orderblockValidator.js.
  const allLevels = [...(orderbook.bids ?? []), ...(orderbook.asks ?? [])];
  const bookAvgLevelSize = allLevels.length > 0 ? allLevels.reduce((s, [, size]) => s + size, 0) / allLevels.length : 0;
  const favorableAvgInBand = favorableLevels.length > 0
    ? favorableLevels.reduce((s, [, size]) => s + size, 0) / favorableLevels.length
    : 0;
  const orderBookDepthRatio = bookAvgLevelSize === 0 ? 1 : favorableAvgInBand / bookAvgLevelSize;
  const depthRatioScore = clamp01((orderBookDepthRatio - 1) / 2); // full score at 3x the book's average

  // Spread: tight = more trustworthy read and cheaper to actually enter on.
  const bestBid = orderbook.bids?.[0]?.[0];
  const bestAsk = orderbook.asks?.[0]?.[0];
  let spreadScore = 0;
  if (bestBid && bestAsk && bestBid > 0) {
    const spreadPct = (bestAsk - bestBid) / bestBid;
    spreadScore = clamp01(1 - spreadPct / 0.002); // full score at 0 spread, 0 score at >=0.2% spread
  }

  const breakdown = { imbalance: imbalanceScore, wall: wallScore, depthRatio: depthRatioScore, spread: spreadScore };
  const weightedSum = Object.entries(breakdown).reduce((s, [key, value]) => s + value * WEIGHTS[key], 0);
  const totalWeight = Object.values(WEIGHTS).reduce((s, w) => s + w, 0);
  const score = Math.round((weightedSum / totalWeight) * 100);

  return { score, breakdown, orderBookDepthRatio };
}

module.exports = { computeOrderbookProbability };
