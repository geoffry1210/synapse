/**
 * demo-cipherb.js
 * -----------------------------------------------------------------------
 * Runs WaveTrend/MFI/VWAP against a longer synthetic downtrend-then-
 * reversal series (indicators need real warmup length to mean anything),
 * prints where each mandatory flag fires, and shows a SetupManager
 * picking up those flags via reportCipherBFlags() as it would in the
 * live engine.
 * -----------------------------------------------------------------------
 */

const { SetupManager } = require('./core/setupManager');
const { precomputeCipherB, reportCipherBFlags } = require('./confluence/cipherB');

function generateCandles() {
  const candles = [];
  let price = 200;
  let seed = 42;

  // deterministic pseudo-random so the demo is reproducible
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };

  // Phase 1: grinding downtrend, 40 candles, with rising volume near the
  // end (capitulation-style volume climax feeding MFI toward oversold).
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

  // Phase 2: reversal up, 20 candles.
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
const precomputed = precomputeCipherB(candles, { vwapAnchorIndex: 0 });

console.log('WaveTrend dots found:');
precomputed.waveTrend.forEach((pt, i) => {
  if (pt.dot) console.log(`  #${i}: ${pt.dot} dot (wt1=${pt.wt1.toFixed(1)}, wt2=${pt.wt2.toFixed(1)})`);
});

console.log('\nMFI at a few checkpoints:');
[14, 25, 35, 39, 45, 55].forEach((i) => {
  console.log(`  #${i}: MFI=${precomputed.mfi[i]?.toFixed(1) ?? 'n/a'}`);
});

console.log('\nVWAP vs close near the bottom (idx 35-42):');
for (let i = 35; i <= 42; i++) {
  console.log(`  #${i}: close=${candles[i].close.toFixed(2)} vwap=${precomputed.vwap[i]?.toFixed(2) ?? 'n/a'}`);
}

// --- Wire into a SetupManager as it would run live ---
// Simulate a bullish setup manually "identified" at candle 38 (near the
// bottom) sitting in its OB zone, then walk forward reporting flags.
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

console.log('\nWalking forward from candle 38, reporting Cipher B flags:');
for (let i = 38; i < 50; i++) {
  reportCipherBFlags(mgr, candles[i], i, precomputed);
  if (mgr.hasFullConfluence()) {
    console.log(`  Mandatory trio complete by candle #${i}:`, mgr.activeSetup.confluences.mandatory);
    break;
  }
}
if (!mgr.hasFullConfluence()) {
  console.log('  Mandatory trio did not complete in this window. Flags seen so far:', mgr.activeSetup.confluences.mandatory);
}
