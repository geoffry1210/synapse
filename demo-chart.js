/**
 * demo-chart.js
 * -----------------------------------------------------------------------
 * Renders chart snapshots for the same structure scenario used in
 * demo-main.js, at a few different setup stages, and saves them as PNG
 * files so you can actually look at the output.
 * -----------------------------------------------------------------------
 */

const fs = require('fs');
const { detectStructure } = require('./core/structure');
const { computeFibLevels } = require('./core/fibonacci');
const { findOrderBlock } = require('./core/orderblock');
const { renderSetupChart } = require('./charts/candlestickChart');

function buildCandles(raw) {
  return raw.map(([open, high, low, close], i) => ({ time: i, open, high, low, close, volume: 1000 }));
}

const raw = [
  [100, 102, 96, 97], [97, 98, 92, 93], [93, 94, 88, 89], [89, 90, 85, 86], [86, 87, 80, 83],
  [83, 91, 81, 90], [90, 93, 88, 92], [92, 92, 84, 88], [88, 96, 87, 95], [95, 104, 94, 103],
  [103, 112, 102, 111], [111, 122, 110, 120],
  [120, 121, 108, 110], [110, 111, 100, 101], [101, 102, 90, 91], [91, 95, 89, 94],
  [94, 98, 93, 97], [97, 108, 96, 106], [106, 120, 105, 119],
];
const candles = buildCandles(raw);
const events = detectStructure(candles, 1);
const event = events[0];
const fib = computeFibLevels(event);
const ob = findOrderBlock(candles, event);

const baseSetup = { direction: event.direction, ob, fib };

const stages = [
  { name: 'ob-identified', candlesSlice: candles.slice(0, 14), setup: { ...baseSetup, status: 'OB_IDENTIFIED' } },
  { name: 'awaiting-confluence', candlesSlice: candles.slice(0, 16), setup: { ...baseSetup, status: 'IN_ZONE_AWAITING_CONFLUENCE' } },
  { name: 'in-trade', candlesSlice: candles.slice(0, 19), setup: { ...baseSetup, status: 'IN_TRADE' } },
];

for (const stage of stages) {
  const buf = renderSetupChart(stage.candlesSlice, stage.setup, {
    title: `BTCUSDT — ${stage.setup.direction.toUpperCase()} — ${stage.setup.status}`,
  });
  const path = `/home/claude/trading-bot/chart-${stage.name}.png`;
  fs.writeFileSync(path, buf);
  console.log(`Saved ${path} (${buf.length} bytes)`);
}
