/**
 * demo-journal.js
 * -----------------------------------------------------------------------
 * Verifies Journal.syncLog() correctly translates a SetupManager's event
 * log into DB writes, using a mock pool that just records every query
 * instead of hitting a real Postgres instance. Reuses the override
 * scenario from demo-override.js to get a realistic sequence of events
 * (setup created -> cancelled by override -> new setup created).
 * -----------------------------------------------------------------------
 */

const { detectStructure } = require('./core/structure');
const { computeFibLevels } = require('./core/fibonacci');
const { SetupManager } = require('./core/setupManager');
const { Journal } = require('./journal/journal');

// --- Mock pool: records every query instead of executing it ---
function createMockPool() {
  const calls = [];
  let fakeIdCounter = 1;
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql: sql.trim().split('\n')[0], params });
      // Fake a RETURNING id result for INSERTs that ask for one.
      if (/RETURNING id/i.test(sql)) {
        return { rows: [{ id: fakeIdCounter++ }] };
      }
      return { rows: [] };
    },
  };
}

function buildCandles(raw) {
  return raw.map(([open, high, low, close], i) => ({ time: i, open, high, low, close, volume: 1000 }));
}

const raw = [
  [100, 102, 96, 97], [97, 98, 92, 93], [93, 94, 88, 89], [89, 90, 85, 86], [86, 87, 80, 83],
  [83, 91, 81, 90], [90, 93, 88, 92], [92, 92, 84, 88], [88, 96, 87, 95], [95, 104, 94, 103],
  [103, 112, 102, 111], [111, 122, 110, 120],
  [120, 121, 108, 110], [110, 111, 100, 101], [101, 103, 95, 102], [102, 103, 79, 82], [82, 86, 81, 85],
];

const candles = buildCandles(raw);
const events = detectStructure(candles, 1);

async function main() {
  const pool = createMockPool();
  const journal = new Journal(pool);
  const mgr = new SetupManager('DEMOUSDT');

  // Recreate scenario 1 from demo-override.js: setup created, then
  // superseded by an opposing setup while still awaiting confluence.
  if (events[0]) mgr.onStructureEvent(candles, events[0], computeFibLevels(events[0]));
  mgr.onPriceUpdate(candles[9], 9);
  if (events[1]) mgr.onStructureEvent(candles, events[1], computeFibLevels(events[1]));

  await journal.syncLog(mgr, 'bybit');

  console.log(`Mock DB received ${pool.calls.length} queries:\n`);
  pool.calls.forEach((c, i) => console.log(`${i + 1}. ${c.sql}  params=${JSON.stringify(c.params)}`));

  // Calling syncLog again with no new events should be a no-op.
  await journal.syncLog(mgr, 'bybit');
  console.log(`\nAfter a second syncLog() with no new events: ${pool.calls.length} total queries (should be unchanged)`);
}

main();
