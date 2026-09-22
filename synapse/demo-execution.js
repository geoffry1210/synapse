/**
 * demo-execution.js
 * -----------------------------------------------------------------------
 * Exercises ExecutionRouter mirroring an entry across 4 dry-run venues
 * (simulating Bybit/MEXC/Bitget/Weex), including one that's deliberately
 * broken (no price set) to prove a single venue failing doesn't block
 * the others. Then mirrors TP1 (partial close) and an SL-to-breakeven
 * move across whatever venues actually succeeded.
 * -----------------------------------------------------------------------
 */

const { DryRunAdapter } = require('./execution/dryRunAdapter');
const { ExecutionRouter } = require('./execution/executionRouter');

async function main() {
  const bybit = new DryRunAdapter('bybit', 10000);
  const mexc = new DryRunAdapter('mexc', 5000);
  const bitget = new DryRunAdapter('bitget', 8000);
  const weex = new DryRunAdapter('weex', 3000); // deliberately left without a price set -> will fail

  const symbol = 'BTCUSDT';
  bybit.setPrice(symbol, 84);
  mexc.setPrice(symbol, 84);
  bitget.setPrice(symbol, 84);
  // weex.setPrice() intentionally NOT called -> placeMarketOrder will throw

  const router = new ExecutionRouter(
    { bybit, mexc, bitget, weex },
    { mode: 'per_venue', riskPct: 1 } // 1% of each venue's balance risked per trade
  );

  const fib = { entry: 84, sl: 73.74, tp1: 95.4, tp2: 107.484, tpFull: 118.2 };

  console.log('=== Mirroring entry across 4 venues (weex should fail) ===\n');
  const entryResults = await router.mirrorEntry(symbol, 'bullish', fib);
  for (const [venue, result] of Object.entries(entryResults)) {
    console.log(`${venue}:`, result);
  }

  console.log('\n=== Mirroring TP1 (30% close) across venues that succeeded ===\n');
  const tp1Results = await router.mirrorClosePercentage(symbol, 'bullish', 30);
  for (const [venue, result] of Object.entries(tp1Results)) {
    console.log(`${venue}:`, result);
  }

  console.log('\n=== Mirroring SL move to breakeven (entry price) ===\n');
  const slMoveResults = await router.mirrorMoveStopLoss(symbol, fib.entry);
  for (const [venue, result] of Object.entries(slMoveResults)) {
    console.log(`${venue}:`, result);
  }

  console.log('\n=== Final balances (bybit/mexc/bitget should reflect TP1 PnL; weex unchanged) ===\n');
  for (const [name, adapter] of Object.entries({ bybit, mexc, bitget, weex })) {
    console.log(`${name}: balance=${(await adapter.getBalance()).toFixed(2)}`);
  }
}

main();
