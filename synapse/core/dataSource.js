/**
 * dataSource.js
 * -----------------------------------------------------------------------
 * Implements the two things main.js left as stubs:
 *   - fetchCandlesFor(exchange, symbol, timeframe, limit) — OHLCV for the
 *     main engine's signal source, via ccxt.
 *   - buildScannerUniverse(exchanges, opts) — candles for every active
 *     symbol across the given exchanges (for the pump/dump scanner),
 *     with optional CoinGecko-based market-cap tiering for the
 *     low/mid/large weighting the scanner uses.
 *
 * ⚠️ Not runnable inside this sandbox — needs network access to real
 * exchange APIs and (optionally) api.coingecko.com, neither reachable
 * here. Structurally verified against the installed ccxt package
 * (fetchOHLCV/fetchTickers/loadMarkets all confirmed present on
 * ccxt.bybit — see the checks run while building this), but the actual
 * HTTP round-trips haven't been exercised. Test against exchange
 * testnets before relying on this for real signals.
 * -----------------------------------------------------------------------
 */

const { runWithLimit } = require('./concurrencyLimit');

/**
 * Fetch OHLCV candles for one symbol from a ccxt exchange instance and
 * map them into this codebase's {time,open,high,low,close,volume} shape.
 *
 * IMPORTANT: exchanges return the still-forming, in-progress candle as
 * the last row of OHLCV data, and it keeps changing in real time until
 * that period closes. Feeding that into structure detection makes BOS/
 * CHoCH flicker on every poll as the live candle's high/low shifts —
 * this function always drops it, so only fully-closed candles reach the
 * engine. (This is exactly what caused live setups to flap rapidly
 * between bullish/bearish before this fix — every test before this used
 * static historical arrays, which never had an in-progress candle to
 * expose the bug.)
 *
 * @param {import('ccxt').Exchange} exchange - a ccxt exchange instance (e.g. adapters.bybit.exchange)
 * @param {string} symbol - ccxt unified symbol, e.g. "BTC/USDT"
 * @param {string} timeframe - e.g. '1h', '4h', '15m'
 * @param {number} limit - number of CLOSED candles to return
 * @returns {Promise<import('./swings').Candle[]>}
 */
async function fetchCandlesFor(exchange, symbol, timeframe = '1h', limit = 200) {
  // Fetch one extra so that after dropping the in-progress candle we
  // still have `limit` closed ones.
  const ohlcv = await exchange.fetchOHLCV(symbol, timeframe, undefined, limit + 1);
  const candles = ohlcv.map(([time, open, high, low, close, volume]) => ({ time, open, high, low, close, volume }));

  const timeframeMs = exchange.parseTimeframe(timeframe) * 1000;
  const last = candles[candles.length - 1];
  const lastIsClosed = last && last.time + timeframeMs <= Date.now();

  const closedCandles = lastIsClosed ? candles : candles.slice(0, -1);
  return closedCandles.slice(-limit);
}

/**
 * Fetch market-cap rank data from CoinGecko's free public endpoint and
 * build a symbol -> { rank, tier } map. Tiers: top 20 = 'large',
 * top 100 = 'mid', everything else (or unranked/unlisted) = 'low'.
 *
 * Note: CoinGecko's free API sometimes rate-limits or blocks requests
 * from cloud-hosting IP ranges (Render, AWS, etc.) more aggressively
 * than residential ones, since so many free-tier apps share those
 * ranges. A User-Agent header is included since bare/default requests
 * are more likely to get blocked — but if this keeps failing in
 * production, that's the most likely reason, not a bug in this code.
 *
 * @returns {Promise<Map<string, { rank: number, tier: 'low'|'mid'|'large' }>>}
 */
async function fetchMarketCapTiers() {
  const map = new Map();
  const perPage = 250;
  const pages = 2; // top 500 coins by market cap is plenty for tiering purposes

  for (let page = 1; page <= pages; page++) {
    const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${perPage}&page=${page}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'synapse-trading-bot/1.0' } });
    if (!res.ok) throw new Error(`CoinGecko request failed: ${res.status} ${res.statusText}`);
    const coins = await res.json();

    for (const coin of coins) {
      const symbol = coin.symbol.toUpperCase();
      const rank = coin.market_cap_rank;
      const tier = rank <= 20 ? 'large' : rank <= 100 ? 'mid' : 'low';
      map.set(symbol, { rank, tier });
    }
  }

  return map;
}

/**
 * Build the { SYMBOL: { candles, tier, venue, derivativesData } } map the
 * scanner (scanner/scanner.js) expects, across every active symbol on
 * the given exchanges. Deliberately NOT whitelist-restricted — the
 * scanner is supposed to catch low-cap pumps the main engine ignores.
 *
 * @param {Record<string, import('ccxt').Exchange>} exchanges - e.g. { bybit: adapters.bybit.exchange, weex: adapters.weex.exchange }
 * @param {{ timeframe?: string, candleLimit?: number, concurrency?: number, quoteFilter?: string, precomputedTiers?: Map }} opts
 *   precomputedTiers: pass an already-fetched tier map (e.g. from a cache) to
 *   skip this function's own CoinGecko call entirely — useful since tiers
 *   barely change minute to minute and refetching every scan cycle is wasteful.
 * @returns {Promise<{ universe: Record<string, object>, tiersAvailable: boolean, tierError: string|null }>}
 */
async function buildScannerUniverse(exchanges, opts = {}) {
  const timeframe = opts.timeframe ?? '1h';
  const candleLimit = opts.candleLimit ?? 30; // enough for the 24h pump window at 1h candles, plus buffer
  const concurrency = opts.concurrency ?? 8;
  const quoteFilter = opts.quoteFilter ?? 'USDT'; // only scan USDT-quoted pairs by default

  let tiers = opts.precomputedTiers;
  let tiersAvailable = true;
  let tierError = null;
  if (!tiers) {
    try {
      tiers = await fetchMarketCapTiers();
    } catch (err) {
      tiersAvailable = false;
      tierError = err.message;
      tiers = new Map();
      console.error('CoinGecko tiering unavailable, all symbols will default to "low" tier:', err.message);
    }
  }

  const universe = {};

  for (const [venue, exchange] of Object.entries(exchanges)) {
    await exchange.loadMarkets();
    const symbols = Object.values(exchange.markets)
      .filter((m) => m.active && m.quote === quoteFilter)
      .map((m) => m.symbol);

    const tasks = symbols.map((symbol) => async () => {
      const candles = await fetchCandlesFor(exchange, symbol, timeframe, candleLimit);
      const base = symbol.split('/')[0].toUpperCase();
      const tierInfo = tiers.get(base);
      return { symbol: symbol.replace('/', ''), venue, candles, tier: tierInfo?.tier ?? 'low' };
    });

    const results = await runWithLimit(tasks, concurrency);
    for (const result of results) {
      if (result?.error) continue; // skip symbols that failed to fetch, don't abort the whole sweep
      universe[result.symbol] = { candles: result.candles, tier: result.tier, venue: result.venue };
    }
  }

  return { universe, tiersAvailable, tierError };
}

module.exports = { fetchCandlesFor, fetchMarketCapTiers, buildScannerUniverse };
