/**
 * demo-scanner.js
 * -----------------------------------------------------------------------
 * Runs the scanner across 3 synthetic symbols:
 *   - LOWCOINUSDT: low-cap, pumps +80% then shows clear exhaustion
 *     (volume climax, overbought + divergence, upper wick rejection)
 *     -> should score a HIGH dump probability.
 *   - BTCUSDT: large-cap, pumps +35% via a smooth steady climb with no
 *     exhaustion signs yet -> should score LOW dump probability despite
 *     qualifying as "pumped".
 *   - QUIETCOINUSDT: no pump at all -> should produce no alert.
 * -----------------------------------------------------------------------
 */

const { scanMarket, formatAlertMessage } = require('./scanner/scanner');

function seededRand(seed) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

/** Pumps hard, then shows exhaustion: volume spike, upper wicks, fade. */
function generateLowCapPumpAndFade() {
  const rand = seededRand(7);
  const candles = [];
  let price = 1.0;

  // Quiet accumulation, 20 candles
  for (let i = 0; i < 20; i++) {
    const close = price + (rand() - 0.5) * 0.01;
    candles.push({ time: i, open: price, high: Math.max(price, close) + 0.002, low: Math.min(price, close) - 0.002, close, volume: 500 + rand() * 100 });
    price = close;
  }

  // Sharp pump, 8 candles, +80%+
  for (let i = 20; i < 28; i++) {
    const open = price;
    const close = price * (1 + 0.08 + rand() * 0.05);
    candles.push({ time: i, open, high: close + close * 0.01, low: open - open * 0.005, close, volume: 2000 + i * 800 + rand() * 500 });
    price = close;
  }

  // Exhaustion candle: long upper wick, small body, huge volume (climax), close well off the high
  const exhaustOpen = price;
  const exhaustClose = price * 1.01;
  const exhaustHigh = price * 1.12; // big upper wick
  candles.push({ time: 28, open: exhaustOpen, high: exhaustHigh, low: exhaustOpen * 0.99, close: exhaustClose, volume: 15000 });
  price = exhaustClose;

  // Fading volume + a bearish engulfing right after
  const fadeOpen = price;
  const fadeClose = price * 0.94;
  candles.push({ time: 29, open: fadeOpen, high: fadeOpen * 1.005, low: fadeClose * 0.99, close: fadeClose, volume: 6000 });

  return candles;
}

/** Smooth steady climb — pumps +35% but no exhaustion signs yet. */
function generateLargeCapSmoothPump() {
  const rand = seededRand(99);
  const candles = [];
  let price = 60000;

  for (let i = 0; i < 24; i++) {
    const drift = 700 + rand() * 300; // steady grind up
    const open = price;
    const close = price + drift;
    const high = close + rand() * 100;
    const low = open - rand() * 100;
    candles.push({ time: i, open, high, low, close, volume: 1000 + rand() * 100 }); // flat, unremarkable volume
    price = close;
  }

  return candles;
}

/** No pump at all — flat chop. */
function generateQuietMarket() {
  const rand = seededRand(3);
  const candles = [];
  let price = 5.0;

  for (let i = 0; i < 24; i++) {
    const close = price + (rand() - 0.5) * 0.05;
    candles.push({ time: i, open: price, high: Math.max(price, close) + 0.02, low: Math.min(price, close) - 0.02, close, volume: 400 + rand() * 50 });
    price = close;
  }

  return candles;
}

const symbolCandleMap = {
  LOWCOINUSDT: {
    candles: generateLowCapPumpAndFade(),
    tier: 'low',
    venue: 'weex',
  },
  BTCUSDT: {
    candles: generateLargeCapSmoothPump(),
    tier: 'large',
    venue: 'bybit',
    derivativesData: { fundingRate: 0.0002, openInterestChangePct: 8 }, // mild, not extreme
  },
  QUIETCOINUSDT: {
    candles: generateQuietMarket(),
    tier: 'mid',
    venue: 'bybit',
  },
};

const alerts = scanMarket(symbolCandleMap, { windowCandles: 24, thresholdPct: 30 });

console.log(`${alerts.length} alert(s) generated:\n`);
for (const alert of alerts) {
  console.log(formatAlertMessage(alert));
  console.log('');
}
