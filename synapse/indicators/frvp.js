/**
 * frvp.js
 * -----------------------------------------------------------------------
 * Fixed Range Volume Profile — standard public methodology:
 *   1. Take a fixed range of candles (e.g. the BOS/CHoCH impulse leg).
 *   2. Split the price range into N horizontal bins.
 *   3. Distribute each candle's volume across the bins its high-low
 *      range overlaps, proportional to the overlap.
 *   4. POC (Point of Control) = the bin with the most volume.
 *   5. Value Area = the smallest set of contiguous bins around the POC
 *      that contain `valueAreaPct` (default 70%) of total volume.
 *      VAH/VAL = the high/low edges of that area.
 *
 * Used here as a confluence check: if price is reacting at the OB and
 * that level also lines up with the POC or a Value Area edge, that's a
 * historically significant volume node — added confidence for the zone.
 * -----------------------------------------------------------------------
 */

const DEFAULT_BINS = 24;
const DEFAULT_VALUE_AREA_PCT = 0.7;

/**
 * @typedef {Object} FRVPResult
 * @property {number} poc
 * @property {number} vah
 * @property {number} val
 * @property {{ low: number, high: number, volume: number }[]} bins
 */

/**
 * @param {import('../core/swings').Candle[]} candles
 * @param {number} startIndex - inclusive
 * @param {number} endIndex   - inclusive
 * @param {{ binCount?: number, valueAreaPct?: number }} opts
 * @returns {FRVPResult|null}
 */
function computeFRVP(candles, startIndex, endIndex, opts = {}) {
  const binCount = opts.binCount ?? DEFAULT_BINS;
  const valueAreaPct = opts.valueAreaPct ?? DEFAULT_VALUE_AREA_PCT;

  const slice = candles.slice(startIndex, endIndex + 1);
  if (slice.length === 0) return null;

  const rangeLow = Math.min(...slice.map((c) => c.low));
  const rangeHigh = Math.max(...slice.map((c) => c.high));
  if (rangeHigh <= rangeLow) return null;

  const binSize = (rangeHigh - rangeLow) / binCount;
  const bins = Array.from({ length: binCount }, (_, i) => ({
    low: rangeLow + i * binSize,
    high: rangeLow + (i + 1) * binSize,
    volume: 0,
  }));

  for (const c of slice) {
    const candleRange = c.high - c.low;
    for (const bin of bins) {
      const overlapLow = Math.max(bin.low, c.low);
      const overlapHigh = Math.min(bin.high, c.high);
      const overlap = Math.max(0, overlapHigh - overlapLow);
      if (overlap <= 0) continue;

      const proportion = candleRange === 0 ? 1 : overlap / candleRange;
      bin.volume += c.volume * proportion;
    }
  }

  const totalVolume = bins.reduce((sum, b) => sum + b.volume, 0);
  let pocIndex = 0;
  for (let i = 1; i < bins.length; i++) {
    if (bins[i].volume > bins[pocIndex].volume) pocIndex = i;
  }

  // Expand outward from the POC, always adding whichever neighbor bin
  // has more volume, until the value area threshold is reached.
  let vaLowIdx = pocIndex;
  let vaHighIdx = pocIndex;
  let vaVolume = bins[pocIndex].volume;
  const targetVolume = totalVolume * valueAreaPct;

  while (vaVolume < targetVolume && (vaLowIdx > 0 || vaHighIdx < bins.length - 1)) {
    const belowVol = vaLowIdx > 0 ? bins[vaLowIdx - 1].volume : -1;
    const aboveVol = vaHighIdx < bins.length - 1 ? bins[vaHighIdx + 1].volume : -1;

    if (aboveVol >= belowVol) {
      vaHighIdx++;
      vaVolume += bins[vaHighIdx].volume;
    } else {
      vaLowIdx--;
      vaVolume += bins[vaLowIdx].volume;
    }
  }

  return {
    poc: (bins[pocIndex].low + bins[pocIndex].high) / 2,
    vah: bins[vaHighIdx].high,
    val: bins[vaLowIdx].low,
    bins,
  };
}

/**
 * Confluence flag: is the given price near the POC or the value-area
 * edge that matters for this direction (VAL supports longs, VAH
 * supports shorts)?
 *
 * @param {number} price
 * @param {FRVPResult|null} frvp
 * @param {'bullish'|'bearish'} direction
 * @param {number} tolerancePct - e.g. 0.005 = within 0.5% of the level
 */
function frvpSupportsDirection(price, frvp, direction, tolerancePct = 0.005) {
  if (!frvp) return false;

  const relevantLevel = direction === 'bullish' ? frvp.val : frvp.vah;
  const nearPOC = Math.abs(price - frvp.poc) / frvp.poc <= tolerancePct;
  const nearLevel = Math.abs(price - relevantLevel) / relevantLevel <= tolerancePct;

  return nearPOC || nearLevel;
}

module.exports = { computeFRVP, frvpSupportsDirection, DEFAULT_BINS, DEFAULT_VALUE_AREA_PCT };
