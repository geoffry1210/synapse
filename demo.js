/**
 * demo.js
 * -----------------------------------------------------------------------
 * Generates a synthetic candle series with a clear swing structure and
 * runs it through: swings -> structure (BOS/CHoCH) -> order block ->
 * fib levels. This is a sanity-check harness, not real market data —
 * once you're ready, swap `generateSampleCandles()` for real OHLCV
 * pulled from an exchange.
 * -----------------------------------------------------------------------
 */

const { detectStructure } = require('./core/structure');
const { findOrderBlock, checkInvalidation, isPriceInZone } = require('./core/orderblock');
const { computeFibLevels } = require('./core/fibonacci');

function generateSampleCandles() {
  // Hand-built to contain: downswing -> higher low -> impulse up that
  // breaks the prior swing high (bullish CHoCH), with a bearish OB
  // candle right before the impulse leg, followed by a pullback into
  // the OB zone.
  const raw = [
    // idx 0-4: initial down leg forming swing low at idx 4
    [100, 102, 96, 97],
    [97, 98, 92, 93],
    [93, 94, 88, 89],
    [89, 90, 85, 86],
    [86, 87, 80, 83], // swing low = 80
    // idx 5-7: chop / minor bounce forming a swing high, then the OB candle
    [83, 91, 81, 90],
    [90, 93, 88, 92], // swing high = 93
    [92, 92, 84, 88], // <- bearish OB candle (down close before impulse), low=84 defines OB zone floor
    // idx 8-11: impulse leg up, breaks 93 swing high -> bullish CHoCH
    [88, 96, 87, 95],
    [95, 104, 94, 103],
    [103, 112, 102, 111],
    [111, 122, 110, 120], // structure break candle (close > 93), also new swing high
    // idx 12-15: pullback back down into the OB zone (84-92)
    [120, 121, 108, 110],
    [110, 111, 100, 101],
    [101, 102, 85, 91], // wicks into OB zone (84-92)
    [91, 96, 89, 94],
  ];

  return raw.map(([open, high, low, close], i) => ({
    time: i,
    open,
    high,
    low,
    close,
    volume: 1000 + i * 10,
  }));
}

function main() {
  const candles = generateSampleCandles();

  const events = detectStructure(candles, /* lookback */ 1);
  console.log(`Detected ${events.length} structure event(s):\n`);

  for (const event of events) {
    console.log(
      `[${event.type}] ${event.direction} — broke ${event.brokenSwing.type} @ ${event.brokenSwing.price} ` +
        `on candle #${event.breakIndex} (close ${event.breakPrice})`
    );

    const ob = findOrderBlock(candles, event);
    if (!ob) {
      console.log('  -> no order block found for this leg\n');
      continue;
    }
    console.log(
      `  -> Order block: candle #${ob.index}, range [${ob.low}, ${ob.high}] (${ob.direction})`
    );

    const fib = computeFibLevels(event);
    console.log(
      `  -> Fib levels: entry=${fib.entry.toFixed(2)} sl=${fib.sl.toFixed(2)} ` +
        `tp1=${fib.tp1.toFixed(2)} tp2=${fib.tp2.toFixed(2)} tpFull=${fib.tpFull.toFixed(2)}`
    );

    // Walk forward to see if/when the OB gets tapped or invalidated.
    for (let i = ob.index + 1; i < candles.length; i++) {
      checkInvalidation(ob, candles[i], i);
      if (!ob.valid) {
        console.log(`  -> OB invalidated at candle #${i} (wick through)\n`);
        break;
      }
      if (isPriceInZone(ob, candles[i])) {
        console.log(`  -> Price entered OB zone at candle #${i}`);
      }
    }
    console.log('');
  }
}

main();
