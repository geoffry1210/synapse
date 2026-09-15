/**
 * whitelist.js
 * -----------------------------------------------------------------------
 * Restricts the MAIN TRADING ENGINE to major pairs with good fundamentals
 * — this does NOT apply to the pump/dump scanner, which intentionally
 * scans the whole exchange (see scanner/scanner.js).
 *
 * Two ways to use it, and you can combine both:
 *
 *  1. STATIC LIST — you maintain an explicit list of approved symbols.
 *     Simple, fully under your control, no surprises.
 *
 *  2. RULES-BASED FILTER — pass live market data (market cap rank,
 *     24h volume) and it's evaluated against thresholds. Useful if you'd
 *     rather the universe adjust automatically as coins grow/shrink
 *     instead of hand-maintaining a list forever.
 *
 * Default mode is STATIC, since that's the simplest and most predictable
 * for a live trading engine. Switch modes via `opts.mode`.
 * -----------------------------------------------------------------------
 */

// Starting curated list — large-cap, established, liquid pairs. Edit
// this freely; it's just data, not logic.
const DEFAULT_WHITELIST = [
  'BTCUSDT',
  'ETHUSDT',
  'SOLUSDT',
  'BNBUSDT',
  'XRPUSDT',
  'ADAUSDT',
  'AVAXUSDT',
  'LINKUSDT',
  'DOTUSDT',
  'LTCUSDT',
  'BCHUSDT',
  'MATICUSDT',
  'TRXUSDT',
  'ATOMUSDT',
  'NEARUSDT',
];

const DEFAULT_RULES = {
  maxMarketCapRank: 50, // top 50 by market cap
  minDailyVolumeUSD: 100_000_000, // $100M+ daily volume
};

/**
 * @typedef {Object} MarketData
 * @property {number} [marketCapRank]
 * @property {number} [dailyVolumeUSD]
 */

class WhitelistFilter {
  /**
   * @param {{ mode?: 'static'|'rules'|'either', staticList?: string[], rules?: Partial<typeof DEFAULT_RULES> }} opts
   *   mode 'either': passes if the symbol is in the static list OR passes the rules — useful during a
   *   transition period from a hand-picked list to a fully automated one.
   */
  constructor(opts = {}) {
    this.mode = opts.mode ?? 'static';
    this.staticList = new Set(opts.staticList ?? DEFAULT_WHITELIST);
    this.rules = { ...DEFAULT_RULES, ...opts.rules };
  }

  /**
   * @param {string} symbol
   * @param {MarketData} [marketData] - required for 'rules'/'either' modes
   * @returns {boolean}
   */
  isAllowed(symbol, marketData) {
    const inStaticList = this.staticList.has(symbol);
    const passesRules = marketData ? this._passesRules(marketData) : false;

    switch (this.mode) {
      case 'static':
        return inStaticList;
      case 'rules':
        return passesRules;
      case 'either':
        return inStaticList || passesRules;
      default:
        return inStaticList;
    }
  }

  _passesRules(marketData) {
    const rankOK =
      marketData.marketCapRank === undefined || marketData.marketCapRank <= this.rules.maxMarketCapRank;
    const volumeOK =
      marketData.dailyVolumeUSD === undefined || marketData.dailyVolumeUSD >= this.rules.minDailyVolumeUSD;
    return rankOK && volumeOK;
  }

  addSymbol(symbol) {
    this.staticList.add(symbol);
  }

  removeSymbol(symbol) {
    this.staticList.delete(symbol);
  }

  getList() {
    return Array.from(this.staticList);
  }
}

module.exports = { WhitelistFilter, DEFAULT_WHITELIST, DEFAULT_RULES };
