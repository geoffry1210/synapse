/**
 * demo-strategy-refinement.js
 * -----------------------------------------------------------------------
 * Integration tests for the new HTF bias filter, OB validity scoring, and
 * the two entry models, driven through the real runSymbolCycle() pipeline
 * rather than calling SetupManager directly — this is what actually
 * catches wiring bugs between the new modules and the existing engine.
 * -----------------------------------------------------------------------
 */

const { SetupManager } = require('./core/setupManager');
const { SettingsStore } = require('./core/settingsStore');
const { TradeLimiter } = require('./core/tradeLimiter');
const { Journal } = require('./journal/journal');
const { DryRunAdapter } = require('./execution/dryRunAdapter');
const { ExecutionRouter } = require('./execution/executionRouter');
const { runSymbolCycle } = require('./core/engineCycle');

function mockPool() {
  const store = new Map();
  let seq = 1;
  return {
    async query(sql, params = []) {
      if (sql.startsWith('SELECT value')) return store.has(params[0]) ? { rows: [{ value: store.get(params[0]) }] } : { rows: [] };
      if (sql.startsWith('INSERT INTO bot_settings')) { store.set(params[0], JSON.parse(params[1])); return { rows: [] }; }
      if (sql.startsWith('SELECT COUNT')) return { rows: [{ count: '0' }] };
      if (sql.includes('RETURNING id')) return { rows: [{ id: seq++ }] };
      return { rows: [] };
    },
  };
}

function candles(raw) {
  return raw.map(([o, h, l, cl], i) => ({ time: i * 3600000, open: o, high: h, low: l, close: cl, volume: 1000 + i * 20 }));
}

// The proven bullish-CHoCH dataset used throughout this build.
const BULLISH_RAW = [
  [100, 102, 96, 97], [97, 98, 92, 93], [93, 94, 88, 89], [89, 90, 85, 86], [86, 87, 80, 83],
  [83, 91, 81, 90], [90, 93, 88, 92], [92, 92, 84, 88], [88, 96, 87, 95], [95, 104, 94, 103],
  [103, 112, 102, 111], [111, 122, 110, 120],
  [120, 121, 108, 110], [110, 111, 100, 101], [101, 102, 90, 91], [91, 95, 89, 94],
];

// Explicit rising-pivot series for a clean bullish HTF bias (from htfBias's own testing).
function pivotSeries(pivots) {
  const out = [];
  let t = 0;
  for (let p = 0; p < pivots.length; p++) {
    const price = pivots[p];
    const isHigh = p % 2 === 1;
    for (let i = -2; i <= 2; i++) {
      const offset = isHigh ? -Math.abs(i) * 1.5 : Math.abs(i) * 1.5;
      const c = price + offset;
      out.push({ time: t++ * 3600000, open: c, high: c + (isHigh ? 0.2 : 1.5), low: c - (isHigh ? 1.5 : 0.2), close: c, volume: 1000 });
    }
  }
  return out;
}
const BULLISH_HTF = pivotSeries([100, 110, 105, 118, 112, 126, 119, 134]);
const BEARISH_HTF = pivotSeries([100, 140, 90, 125, 80, 115, 70, 105]);
const CHOPPY_HTF = pivotSeries([100, 110, 101, 111, 100, 110, 101, 111]);

async function makeDeps(symbol) {
  const pool = mockPool();
  const journal = new Journal(pool);
  const settingsStore = new SettingsStore(pool);
  const tradeLimiter = new TradeLimiter(pool, settingsStore);
  await tradeLimiter.setLimit(999);
  const bybit = new DryRunAdapter('bybit', 10000);
  bybit.setPrice(symbol, 84);
  const router = new ExecutionRouter({ bybit }, {}, settingsStore);
  const setupManager = new SetupManager(symbol);
  return { setupManager, router, journal, tradeLimiter, telegramBot: null, venueLabel: 'multi' };
}

async function testHtfRangingSkip() {
  console.log('=== Test 1: HTF ranging blocks new setups entirely ===');
  const deps = await makeDeps('BTCUSDT');
  const c = candles(BULLISH_RAW);
  await runSymbolCycle(c, deps, { structureLookback: 1, htfCandles: { daily: CHOPPY_HTF, fourHour: CHOPPY_HTF }, minObScore: 0 });
  const created = deps.setupManager.log.filter((e) => e.type === 'setup_created');
  const skipped = deps.setupManager.log.filter((e) => e.type === 'setup_skipped' && e.reason === 'htf_ranging');
  console.log('setup_created count (expect 0):', created.length);
  console.log('setup_skipped(htf_ranging) count (expect 1):', skipped.length);
  console.log(created.length === 0 && skipped.length === 1 ? 'PASS' : 'FAIL');
}

async function testObScoreGate() {
  console.log('\n=== Test 2: low OB score blocks setup creation ===');
  const deps = await makeDeps('BTCUSDT');
  const c = candles(BULLISH_RAW);
  // minObScore set unreasonably high -- this simple demo OB wasn't engineered
  // to satisfy all 6 validator criteria, so it should score well under 100.
  await runSymbolCycle(c, deps, { structureLookback: 1, minObScore: 100 });
  const created = deps.setupManager.log.filter((e) => e.type === 'setup_created');
  const skipped = deps.setupManager.log.filter((e) => e.type === 'setup_skipped' && e.reason === 'ob_score_too_low');
  console.log('setup_created count (expect 0):', created.length);
  console.log('setup_skipped(ob_score_too_low) count (expect 1):', skipped.length, skipped[0] ? `— scored ${skipped[0].obScore}` : '');
  console.log(created.length === 0 && skipped.length === 1 ? 'PASS' : 'FAIL');
}

async function testBiasAlignment() {
  console.log('\n=== Test 3: alignsWithBias is set correctly (with-bias vs counter-trend) ===');
  const depsWith = await makeDeps('BTCUSDT');
  await runSymbolCycle(candles(BULLISH_RAW), depsWith, { structureLookback: 1, htfCandles: { daily: BULLISH_HTF, fourHour: BULLISH_HTF }, minObScore: 0 });
  console.log('Bullish event + bullish HTF -> alignsWithBias:', depsWith.setupManager.activeSetup?.alignsWithBias, '(expect true)');

  const depsAgainst = await makeDeps('ETHUSDT');
  await runSymbolCycle(candles(BULLISH_RAW), depsAgainst, { structureLookback: 1, htfCandles: { daily: BEARISH_HTF, fourHour: BEARISH_HTF }, minObScore: 0 });
  console.log('Bullish event + bearish HTF -> alignsWithBias:', depsAgainst.setupManager.activeSetup?.alignsWithBias, '(expect false)');
  console.log('setup still created despite counter-trend (soft, not hard-blocked at creation):', depsAgainst.setupManager.activeSetup?.status);
}

async function testEntryModels() {
  console.log('\n=== Test 4: Entry Model 2 (confirmation) withholds entry until LTF CHoCH ===');
  const deps = await makeDeps('BTCUSDT');
  const c = candles(BULLISH_RAW);

  // Walk to zone entry first (no LTF candles yet -> should NOT enter even with confluence).
  await runSymbolCycle(c.slice(0, 15), deps, { structureLookback: 1, minObScore: 0, entryModel: 'confirmation' });
  // Manually seed mandatory+optional confluence to isolate the LTF-gate behavior
  // (real indicator warmup needs 30+ candles, already proven elsewhere in this build).
  deps.setupManager.onConfluenceFlag('mandatory', 'waveTrendDot');
  deps.setupManager.onConfluenceFlag('mandatory', 'mfi');
  deps.setupManager.onConfluenceFlag('mandatory', 'vwap');
  deps.setupManager.onConfluenceFlag('optional', 'rsi');
  deps.setupManager.onConfluenceFlag('optional', 'stochRsi');

  await runSymbolCycle(c.slice(0, 16), deps, { structureLookback: 1, minObScore: 0, entryModel: 'confirmation' });
  console.log('No LTF candles supplied yet -> status:', deps.setupManager.activeSetup?.status, '(expect still IN_ZONE_AWAITING_CONFLUENCE)');

  // Now supply LTF candles containing a matching bullish CHoCH after zone entry.
  const zoneEnteredAt = deps.setupManager.activeSetup.zoneEnteredAt;
  const ltf = BULLISH_RAW.map(([o, h, l, cl], i) => ({ time: zoneEnteredAt + i * 60000, open: o, high: h, low: l, close: cl, volume: 1000 }));
  await runSymbolCycle(c.slice(0, 16), deps, { structureLookback: 1, minObScore: 0, entryModel: 'confirmation', ltfCandles: ltf, ltfLookback: 1 });
  console.log('After matching LTF CHoCH supplied -> status:', deps.setupManager.activeSetup?.status, '(expect IN_TRADE)');
  console.log(deps.setupManager.activeSetup?.status === 'IN_TRADE' ? 'PASS' : 'FAIL');
}

async function main() {
  await testHtfRangingSkip();
  await testObScoreGate();
  await testBiasAlignment();
  await testEntryModels();
}
main();
