/**
 * demo-exitmonitor.js
 * -----------------------------------------------------------------------
 * Walks a bullish trade through TP1 -> TP2 -> full close using
 * processExit(), verifying the SetupManager state and DryRunAdapter
 * balance update correctly at each step. Then runs a second scenario
 * where SL is hit before any TP.
 * -----------------------------------------------------------------------
 */

const { SetupManager } = require('./core/setupManager');
const { processExit } = require('./core/exitMonitor');
const { DryRunAdapter } = require('./execution/dryRunAdapter');
const { ExecutionRouter } = require('./execution/executionRouter');

function makeCandle(high, low) {
  return { time: 0, open: (high + low) / 2, high, low, close: (high + low) / 2, volume: 1000 };
}

async function scenarioFullLifecycle() {
  console.log('=== Scenario 1: TP1 -> TP2 -> full close ===\n');

  const bybit = new DryRunAdapter('bybit', 10000);
  const router = new ExecutionRouter({ bybit });
  const mgr = new SetupManager('BTCUSDT');

  const fib = { entry: 84, sl: 73.74, tp1: 95.4, tp2: 107.484, tpFull: 118.2 };
  mgr.activeSetup = {
    direction: 'bullish',
    ob: { low: 84, high: 92, valid: true },
    fib,
    status: 'IN_TRADE',
    confluences: { mandatory: {}, optional: {} },
    trade: { entryPrice: 84, size: 1, remainingSize: 1, sl: fib.sl, slMovedToEntry: false, tp1Hit: false, tp2Hit: false },
    createdAtIndex: 0,
  };

  bybit.setPrice('BTCUSDT', 84);
  await bybit.placeMarketOrder('BTCUSDT', 'buy', 1);
  router._trackPosition('BTCUSDT', 'bybit', { orderId: 'x', slOrderId: 'y', side: 'buy', size: 1 });

  // Candle that reaches TP1
  bybit.setPrice('BTCUSDT', fib.tp1);
  let result = await processExit(mgr, router, makeCandle(fib.tp1 + 1, fib.entry + 1));
  console.log('Candle hits TP1 ->', result, '| trade state:', mgr.activeSetup.trade);

  // Candle that reaches TP2
  bybit.setPrice('BTCUSDT', fib.tp2);
  result = await processExit(mgr, router, makeCandle(fib.tp2 + 1, fib.tp1 + 1));
  console.log('\nCandle hits TP2 ->', result, '| trade state:', mgr.activeSetup.trade);

  // Candle that reaches full TP
  bybit.setPrice('BTCUSDT', fib.tpFull);
  result = await processExit(mgr, router, makeCandle(fib.tpFull + 1, fib.tp2 + 1));
  console.log('\nCandle hits full TP ->', result, '| setup status:', mgr.activeSetup.status);

  console.log('\nFinal bybit balance:', (await bybit.getBalance()).toFixed(2));
}

async function scenarioStopLoss() {
  console.log('\n\n=== Scenario 2: SL hit before any TP ===\n');

  const bybit = new DryRunAdapter('bybit', 10000);
  const router = new ExecutionRouter({ bybit });
  const mgr = new SetupManager('ETHUSDT');

  const fib = { entry: 3000, sl: 2900, tp1: 3100, tp2: 3200, tpFull: 3300 };
  mgr.activeSetup = {
    direction: 'bullish',
    ob: { low: 3000, high: 3050, valid: true },
    fib,
    status: 'IN_TRADE',
    confluences: { mandatory: {}, optional: {} },
    trade: { entryPrice: 3000, size: 2, remainingSize: 2, sl: fib.sl, slMovedToEntry: false, tp1Hit: false, tp2Hit: false },
    createdAtIndex: 0,
  };

  bybit.setPrice('ETHUSDT', 3000);
  await bybit.placeMarketOrder('ETHUSDT', 'buy', 2);
  router._trackPosition('ETHUSDT', 'bybit', { orderId: 'x', slOrderId: 'y', side: 'buy', size: 2 });

  bybit.setPrice('ETHUSDT', 2890);
  const result = await processExit(mgr, router, makeCandle(3010, 2890));
  console.log('Candle wicks below SL ->', result, '| setup status:', mgr.activeSetup.status);
  console.log('Final bybit balance:', (await bybit.getBalance()).toFixed(2));
}

async function main() {
  await scenarioFullLifecycle();
  await scenarioStopLoss();
}

main();
