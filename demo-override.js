/**
 * demo-override.js
 * -----------------------------------------------------------------------
 * Exercises SetupManager's override rule in two scenarios:
 *   1. Opposing structure event arrives while the first setup is still
 *      awaiting confluence (not yet entered) -> should CANCEL it.
 *   2. Opposing structure event arrives while the first setup is already
 *      IN_TRADE -> should CLOSE the trade.
 * -----------------------------------------------------------------------
 */

const { detectStructure } = require('./core/structure');
const { computeFibLevels } = require('./core/fibonacci');
const { SetupManager } = require('./core/setupManager');

function buildCandles(raw) {
  return raw.map(([open, high, low, close], i) => ({
    time: i,
    open,
    high,
    low,
    close,
    volume: 1000,
  }));
}

function printLog(mgr, label) {
  console.log(`\n=== ${label} ===`);
  for (const entry of mgr.log) {
    const { time, symbol, ...rest } = entry;
    console.log(` ${rest.type}:`, JSON.stringify(rest));
  }
}

// --- Scenario setup: bullish leg (same as demo.js) followed by a sharp
// --- reversal leg that breaks back down through a recent low, producing
// --- a bearish CHoCH shortly after the bullish one.
const raw = [
  [100, 102, 96, 97],
  [97, 98, 92, 93],
  [93, 94, 88, 89],
  [89, 90, 85, 86],
  [86, 87, 80, 83], // swing low 80
  [83, 91, 81, 90],
  [90, 93, 88, 92], // swing high 93
  [92, 92, 84, 88], // bullish-leg OB candle
  [88, 96, 87, 95],
  [95, 104, 94, 103],
  [103, 112, 102, 111],
  [111, 122, 110, 120], // bullish CHoCH confirmed (close > 93), swing high 122
  // --- reversal begins ---
  [120, 121, 108, 110],
  [110, 111, 100, 101], // bearish-leg OB candle (up-close before the drop... adjust below)
  [101, 103, 95, 102], // small bounce -> swing high ~103 (for the bearish leg's own structure)
  [102, 103, 79, 82], // sharp drop breaking below prior swing low (80) -> bearish CHoCH
  [82, 86, 81, 85], // trailing candle so the drop's low registers as a swing under the fractal method
];

const candles = buildCandles(raw);
const events = detectStructure(candles, 1);
console.log(`Structure events: ${events.length}`);
for (const e of events) {
  console.log(` [${e.type}] ${e.direction} broke ${e.brokenSwing.type}@${e.brokenSwing.price} at #${e.breakIndex}`);
}

// --- Scenario 1: override while awaiting confluence ---
const mgr1 = new SetupManager('DEMOUSDT');
if (events[0]) mgr1.onStructureEvent(candles, events[0], computeFibLevels(events[0]));
// walk a couple candles forward (still awaiting confluence, never entered)
mgr1.onPriceUpdate(candles[9], 9);
if (events[1]) mgr1.onStructureEvent(candles, events[1], computeFibLevels(events[1]));
printLog(mgr1, 'Scenario 1: override while awaiting confluence');

// --- Scenario 2: override while already in a trade ---
const mgr2 = new SetupManager('DEMOUSDT');
if (events[0]) mgr2.onStructureEvent(candles, events[0], computeFibLevels(events[0]));
mgr2.enterTrade(84, 1.0); // simulate confluence having fired and a trade being opened
if (events[1]) mgr2.onStructureEvent(candles, events[1], computeFibLevels(events[1]));
printLog(mgr2, 'Scenario 2: override while IN_TRADE');
