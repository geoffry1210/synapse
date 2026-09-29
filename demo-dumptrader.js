/**
 * demo-dumptrader.js
 * -----------------------------------------------------------------------
 * Walks a dump-short through the full lifecycle — entry (via
 * DumpTradeManager.maybeEnter, real fib math off a synthetic pump),
 * TP1 (2RR, 50% close + SL to breakeven), then a reversal-triggered TP2
 * closing the rest — verifying DumpTradeManager/router state and the
 * DryRunAdapter balance at each step. Then a second scenario where SL is
 * hit before TP1. Same style as demo-exitmonitor.js, for the dump-short
 * side of the engine.
 * -----------------------------------------------------------------------
 */

const { DumpTradeManager } = require('./scanner/dumpTrader');
const { processDumpExit } = require('./scanner/dumpExitMonitor');
const { ExecutionRouter } = require('./execution/executionRouter');
const { DryRunAdapter } = require('./execution/dryRunAdapter');

function mockTradeLimiter() {
  return { canOpenNewTrade: async () => ({ allowed: true, tradesThisWeek: 1, limit: 5 }) };
}
function mockControl() {
  return { entriesAllowed: () => true };
}
function flatCandles(price, n = 30) {
  return Array.from({ length: n }, (_, i) => ({
    time: i * 3_600_000,
    open: price,
    high: price,
    low: price,
    close: price,
    volume: 100,
  }));
}
function withLast(candles, patch) {
  const copy = candles.slice(0, -1);
  copy.push(Object.assign({}, candles[candles.length - 1], patch));
  return copy;
}

async function scenarioFullLifecycle() {
  console.log('=== Scenario 1: entry -> TP1 (2RR, 50%) -> reversal TP2 (remaining 50%) ===\n');

  const bybit = new DryRunAdapter('bybit', 10000);
  const router = new ExecutionRouter({ bybit }, { mode: 'per_venue', riskPct: 1 });
  const dumpTrader = new DumpTradeManager();

  // Synthetic pump: pre-pump low 80, currently trading at 100 (a 25% pump),
  // dump probability comfortably above the 70 threshold.
  const alert = {
    symbol: 'PUMPUSDT',
    venue: 'bybit',
    tier: 'low',
    pctGain: 25,
    dumpProbability: 82,
    breakdown: {},
    priorityScore: 82,
    pumpLow: 80,
    pumpIndex: 0,
  };

  bybit.setPrice('PUMPUSDT', 100);
  const entryResult = await dumpTrader.maybeEnter(alert, flatCandles(100), {
    router,
    tradeLimiter: mockTradeLimiter(),
    control: mockControl(),
  });
  const trade = dumpTrader.getTrade('PUMPUSDT');
  console.log('Entry result:', entryResult);
  console.log('Trade opened:', trade);
  // range = 80-100=-20; sl = 100 + -0.4*-20 = 108; R=8; tp1 = 100-16 = 84
  console.log(`Expected sl=108, tp1=84 — got sl=${trade.sl}, tp1=${trade.tp1}\n`);

  // Price falls to TP1.
  bybit.setPrice('PUMPUSDT', 84);
  let result = await processDumpExit(trade, withLast(flatCandles(100), { high: 101, low: 83, close: 90 }), {
    router,
    dumpTradeManager: dumpTrader,
  });
  console.log('Candle hits TP1 ->', result, '| trade state:', dumpTrader.getTrade('PUMPUSDT'));

  // Price continues to fall, then a reversal signal is spotted (forcing
  // it here with reversalThreshold: 0 — reversalProbability.js's own
  // scoring is exercised separately; this demo is about the exit
  // lifecycle wiring, not re-deriving that score).
  bybit.setPrice('PUMPUSDT', 78);
  result = await processDumpExit(trade, withLast(flatCandles(78), { high: 78, low: 77, close: 78 }), {
    router,
    dumpTradeManager: dumpTrader,
    reversalThreshold: 0,
  });
  console.log('\nReversal spotted ->', result, '| still open:', dumpTrader.hasOpenTrade('PUMPUSDT'));
  console.log('Final trade record:', trade);
  console.log('Final bybit balance:', (await bybit.getBalance()).toFixed(2));
}

async function scenarioStopLoss() {
  console.log('\n\n=== Scenario 2: SL hit before TP1 ===\n');

  const bybit = new DryRunAdapter('bybit', 10000);
  const router = new ExecutionRouter({ bybit }, { mode: 'per_venue', riskPct: 1 });
  const dumpTrader = new DumpTradeManager();

  const alert = {
    symbol: 'FAKEOUTUSDT',
    venue: 'bybit',
    tier: 'low',
    pctGain: 30,
    dumpProbability: 75,
    breakdown: {},
    priorityScore: 75,
    pumpLow: 80,
    pumpIndex: 0,
  };

  bybit.setPrice('FAKEOUTUSDT', 100);
  await dumpTrader.maybeEnter(alert, flatCandles(100), {
    router,
    tradeLimiter: mockTradeLimiter(),
    control: mockControl(),
  });
  const trade = dumpTrader.getTrade('FAKEOUTUSDT');
  console.log('Trade opened, sl =', trade.sl, '(expect 108)');

  // Price wicks straight up through SL instead of dumping.
  bybit.setPrice('FAKEOUTUSDT', 109);
  const result = await processDumpExit(trade, withLast(flatCandles(100), { high: 109, low: 99, close: 105 }), {
    router,
    dumpTradeManager: dumpTrader,
  });
  console.log('Candle wicks above SL ->', result, '| still open:', dumpTrader.hasOpenTrade('FAKEOUTUSDT'));
  console.log('Realized P&L (loss expected):', trade.realizedPnl.toFixed(4));
  console.log('Final bybit balance:', (await bybit.getBalance()).toFixed(2));
}

async function main() {
  await scenarioFullLifecycle();
  await scenarioStopLoss();
}

main();
