/**
 * demo-whitelist.js
 * -----------------------------------------------------------------------
 * Exercises all three WhitelistFilter modes, and shows the intended
 * wiring point: the main trading engine checks the whitelist BEFORE
 * feeding a structure event into a symbol's SetupManager, while the
 * pump/dump scanner never checks it at all (by design).
 * -----------------------------------------------------------------------
 */

const { WhitelistFilter, DEFAULT_WHITELIST } = require('./filters/whitelist');

console.log('--- Mode: static (default) ---');
const staticFilter = new WhitelistFilter();
console.log('BTCUSDT allowed?', staticFilter.isAllowed('BTCUSDT')); // true (in default list)
console.log('SHIBUSDT allowed?', staticFilter.isAllowed('SHIBUSDT')); // false (not in default list)

console.log('\n--- Mode: rules ---');
const rulesFilter = new WhitelistFilter({ mode: 'rules', rules: { maxMarketCapRank: 30, minDailyVolumeUSD: 50_000_000 } });
console.log(
  'Rank #15, $80M volume allowed?',
  rulesFilter.isAllowed('SOMECOINUSDT', { marketCapRank: 15, dailyVolumeUSD: 80_000_000 })
); // true
console.log(
  'Rank #120, $2M volume allowed?',
  rulesFilter.isAllowed('SHITCOINUSDT', { marketCapRank: 120, dailyVolumeUSD: 2_000_000 })
); // false

console.log('\n--- Mode: either (static list OR passes rules) ---');
const eitherFilter = new WhitelistFilter({ mode: 'either' });
console.log(
  'BTCUSDT (in static list, no market data given) allowed?',
  eitherFilter.isAllowed('BTCUSDT')
); // true, via static list
console.log(
  'New large coin not yet in static list, rank #10 allowed?',
  eitherFilter.isAllowed('NEWCOINUSDT', { marketCapRank: 10, dailyVolumeUSD: 200_000_000 })
); // true, via rules

console.log('\n--- Wiring point in the main engine (pseudo) ---');
function shouldProcessSymbol(symbol, filter, marketData) {
  return filter.isAllowed(symbol, marketData);
}

const candidates = ['BTCUSDT', 'DOGSHITUSDT', 'ETHUSDT'];
for (const symbol of candidates) {
  const allowed = shouldProcessSymbol(symbol, staticFilter);
  console.log(`  ${symbol}: ${allowed ? 'process through main engine' : 'SKIP (not whitelisted)'}`);
}
console.log('\nNote: the pump/dump scanner ignores this filter entirely and scans every symbol.');
