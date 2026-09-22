/**
 * demo-optional.js
 * -----------------------------------------------------------------------
 * Exercises RSI, StochRSI, FRVP, and candle pattern detection against the
 * same synthetic downtrend-then-reversal series used in demo-cipherb.js,
 * then shows a full SetupManager confluence check requiring the
 * mandatory Cipher B trio AND 2-of-4 optional flags before entering.
 * -----------------------------------------------------------------------
 */

const { SetupManager } = require('./core/setupManager');
const { precomputeCipherB, reportCipherBFlags } = require('./confluence/cipherB');
const { precomputeOptional, reportOptionalFlags } = require('./confluence/optional');
const { computeFRVP } = require('./indicators/frvp');

function generateCandles() {
  const candles = [];
  let price = 200;
  let seed = 42;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };

  for (let i = 0; i < 40; i++) {
    const drift = -1.2 - rand() * 0.8;
    const open = price;
    const close = price + drift + (rand() - 0.5) * 1.5;
    const high = Math.max(open, close) + rand() * 1.2;
    const low = Math.min(open, close) - rand() * 1.2;
    const volume = 1000 + (i > 30 ? (i - 30) * 300 : 0) + rand() * 200;
    candles.push({ time: i, open, high, low, close, volume });
    price = close;
  }
  for (let i = 40; i < 60; i++) {
    const drift = 1.0 + rand() * 1.0;
    const open = price;
    const close = price + drift + (rand() - 0.5) * 1.2;
    const high = Math.max(open, close) + rand() * 1.2;
    const low = Math.min(open, close) - rand() * 1.2;
    const volume = 900 + rand() * 300;
    candles.push({ time: i, open, high, low, close, volume });
    price = close;
  }
  return candles;
}

const candles = generateCandles();
const cipherB = precomputeCipherB(candles, { vwapAnchorIndex: 0 });
const optional = precomputeOptional(candles);

console.log('RSI at checkpoints:');
[14, 25, 35, 39, 45, 55].forEach((i) => console.log(`  #${i}: RSI=${optional.rsi[i]?.toFixed(1) ?? 'n/a'}`));

console.log('\nStochRSI %K at checkpoints:');
[20, 30, 35, 39, 45, 55].forEach((i) => console.log(`  #${i}: %K=${optional.stochRsi.k[i]?.toFixed(1) ?? 'n/a'}`));

console.log('\nFRVP over the leg range [0, 40] (the downtrend):');
const frvp = computeFRVP(candles, 0, 40);
console.log(`  POC=${frvp.poc.toFixed(2)}  VAH=${frvp.vah.toFixed(2)}  VAL=${frvp.val.toFixed(2)}`);
console.log(`  candle #38 close=${candles[38].close.toFixed(2)} (near VAL/POC would support a long here)`);

console.log('\nCandle patterns found:');
const { candlePatternSupportsDirection } = require('./indicators/candlePattern');
for (let i = 1; i < candles.length; i++) {
  if (candlePatternSupportsDirection(candles, i, 'bullish')) console.log(`  #${i}: bullish pattern`);
  if (candlePatternSupportsDirection(candles, i, 'bearish')) console.log(`  #${i}: bearish pattern`);
}

// --- Full confluence check: mandatory trio + 2-of-4 optional ---
const mgr = new SetupManager('DEMOUSDT');
mgr.activeSetup = {
  direction: 'bullish',
  ob: { low: candles[38].low - 1, high: candles[38].high + 1, valid: true },
  fib: { entry: candles[38].low, sl: candles[38].low - 5, tp1: 0, tp2: 0, tpFull: 0 },
  status: 'IN_ZONE_AWAITING_CONFLUENCE',
  confluences: { mandatory: {}, optional: {} },
  trade: null,
  createdAtIndex: 38,
};

console.log('\nWalking forward from candle 38, checking FULL confluence (mandatory + 2 optional):');
for (let i = 38; i < 55; i++) {
  reportCipherBFlags(mgr, candles[i], i, cipherB);
  reportOptionalFlags(mgr, candles, i, optional, frvp);

  if (mgr.hasFullConfluence()) {
    console.log(`  FULL confluence reached at candle #${i}`);
    console.log('  mandatory:', mgr.activeSetup.confluences.mandatory);
    console.log('  optional: ', mgr.activeSetup.confluences.optional);
    mgr.enterTrade(candles[i].close, 1.0);
    break;
  }
}
if (mgr.activeSetup.status !== 'IN_TRADE') {
  console.log('  Did not reach full confluence in this window.');
  console.log('  mandatory so far:', mgr.activeSetup.confluences.mandatory);
  console.log('  optional so far: ', mgr.activeSetup.confluences.optional);
}
