/**
 * bot.js
 * -----------------------------------------------------------------------
 * grammY bot exposing:
 *   - /trades  — recent trades across all symbols
 *   - /journal <SYMBOL> — full setup history for one symbol
 *   - /stats   — win rate, open/closed counts, avg PnL
 *   - /weeklylimit, /setweeklylimit — view/set the weekly trade cap
 *   - /chart <SYMBOL> — on-demand chart snapshot (needs `context.getCandles`
 *     and `context.getSetupManager` wired in from main.js)
 * Plus `notify()`/`notifyScannerAlert()` for pushing events, and
 * `notifyFromEngine()` which auto-forwards a SetupManager's log AND
 * attaches a chart snapshot on milestone events (setup created, entry,
 * TP1/TP2, close).
 *
 * Requires network access to api.telegram.org to actually run — this
 * runs fine on Railway (or any normal host), just not inside this
 * sandboxed dev environment. Everything else in this file (command
 * logic, formatting) is plain JS and was tested via demo-telegram.js
 * with a mock pool, independent of the network layer.
 * -----------------------------------------------------------------------
 */

const { InputFile, Bot } = require('grammy');
const { getRecentTrades, getJournalForSymbol, getStats, formatTradesList, formatJournal, formatStats } = require('./journalQueries');
const { formatEngineEvent, formatScannerAlert } = require('./messages');
const { renderSetupChart } = require('../charts/candlestickChart');
const { SettingsStore } = require('../core/settingsStore');

const CHARTS_ENABLED_KEY = 'chartNotificationsEnabled';

// Event types worth attaching a visual chart to. Kept deliberately small —
// TP1/TP2/setup_created stay text-only, since each chart image costs real
// bandwidth on a free hosting tier. Only the two milestones that most
// benefit from a visual (actually entering, and the trade's final outcome)
// get one. Use /chart <SYMBOL> any time for an on-demand full view.
const CHART_WORTHY_EVENTS = new Set(['trade_entered', 'full_close', 'sl_hit', 'trade_closed']);
// Notification charts render smaller than the full /chart command output —
// still clear enough to read on a phone, at a fraction of the file size.
const NOTIFICATION_CHART_SIZE = { width: 500, height: 300 };

class TradingBot {
  /**
   * @param {string} token - Telegram bot token (from BotFather)
   * @param {string|number} chatId - the chat to push notifications to
   * @param {{ query: (sql: string, params?: any[]) => Promise<any> }} pool - journal DB pool
   * @param {import('../core/tradeLimiter').TradeLimiter} [tradeLimiter] - optional, enables /weeklylimit and /setweeklylimit
   * @param {{ getCandles?: (symbol: string) => Promise<import('../core/swings').Candle[]>, getSetupManager?: (symbol: string) => import('../core/setupManager').SetupManager }} [context]
   *   Wire these from main.js to enable the /chart command.
   */
  constructor(token, chatId, pool, tradeLimiter, context = {}) {
    this.bot = new Bot(token);
    this.chatId = chatId;
    this.pool = pool;
    this.tradeLimiter = tradeLimiter;
    this.context = context;
    this.settingsStore = new SettingsStore(pool);
    this._processedLogLength = new Map(); // symbol -> how much of each SetupManager's log we've notified on

    this._registerCommands();
  }

  _registerCommands() {
    this.bot.command('trades', async (ctx) => {
      const trades = await getRecentTrades(this.pool, 10);
      await ctx.reply(formatTradesList(trades));
    });

    this.bot.command('journal', async (ctx) => {
      const symbol = ctx.match?.trim().toUpperCase();
      if (!symbol) {
        await ctx.reply('Usage: /journal <SYMBOL>  e.g. /journal BTCUSDT');
        return;
      }
      const setups = await getJournalForSymbol(this.pool, symbol, 20);
      await ctx.reply(formatJournal(symbol, setups));
    });

    this.bot.command('stats', async (ctx) => {
      const stats = await getStats(this.pool);
      await ctx.reply(formatStats(stats));
    });

    this.bot.command('weeklylimit', async (ctx) => {
      if (!this.tradeLimiter) {
        await ctx.reply('Weekly trade limit is not configured on this bot instance.');
        return;
      }
      const { allowed, tradesThisWeek, limit } = await this.tradeLimiter.canOpenNewTrade();
      await ctx.reply(
        `📅 Weekly trade limit: ${tradesThisWeek}/${limit} used this week.\n` +
          (allowed ? 'New entries are allowed.' : '🚫 Limit reached — no new entries until next week.')
      );
    });

    this.bot.command('setweeklylimit', async (ctx) => {
      if (!this.tradeLimiter) {
        await ctx.reply('Weekly trade limit is not configured on this bot instance.');
        return;
      }
      const arg = ctx.match?.trim();
      const n = Number(arg);
      if (!arg || !Number.isInteger(n) || n < 0) {
        await ctx.reply('Usage: /setweeklylimit <number>  e.g. /setweeklylimit 5');
        return;
      }
      await this.tradeLimiter.setLimit(n);
      await ctx.reply(`✅ Weekly trade limit set to ${n}.`);
    });

    this.bot.command('chart', async (ctx) => {
      const symbol = ctx.match?.trim().toUpperCase();
      if (!symbol) {
        await ctx.reply('Usage: /chart <SYMBOL>  e.g. /chart BTCUSDT');
        return;
      }
      if (!this.context.getCandles || !this.context.getSetupManager) {
        await ctx.reply('Chart lookup is not wired up on this bot instance (needs getCandles/getSetupManager from main.js).');
        return;
      }

      const candles = await this.context.getCandles(symbol);
      const setupManager = this.context.getSetupManager(symbol);
      if (!candles || candles.length === 0) {
        await ctx.reply(`No candle data available for ${symbol}.`);
        return;
      }

      const buf = renderSetupChart(candles, setupManager?.activeSetup ?? null, {
        title: `${symbol}${setupManager?.activeSetup ? ` — ${setupManager.activeSetup.direction.toUpperCase()} — ${setupManager.activeSetup.status}` : ' — no active setup'}`,
      });
      await ctx.replyWithPhoto(new InputFile(buf, `${symbol}.png`));
    });

    this.bot.command('togglecharts', async (ctx) => {
      const current = await this.settingsStore.get(CHARTS_ENABLED_KEY, true);
      await this.settingsStore.set(CHARTS_ENABLED_KEY, !current);
      await ctx.reply(
        !current
          ? '📊 Chart images re-enabled for trade notifications.'
          : '🚫 Chart images disabled for trade notifications (text-only now, saves bandwidth). Use /chart <SYMBOL> any time for one on demand.'
      );
    });
  }

  /** Start polling for commands. Call once, after registering everything. */
  start() {
    this.bot.start({
      onStart: () => console.log('Telegram bot polling started — commands are live.'),
    }).catch((err) => {
      // A 409 here means another process is already polling with this same
      // bot token (e.g. a second Render instance mid-redeploy, or a local
      // test still running) — Telegram only allows one poller per token.
      // Sending messages (notify/sendChart) still works fine even when this
      // fails, since that's a separate API call, not the polling loop —
      // which is exactly why commands can look "dead" while alerts keep
      // arriving. Logged loudly rather than left as a silent rejection.
      console.error('Telegram bot.start() failed — commands will not work:', err.message);
      if (err.message?.includes('409')) {
        console.error('This looks like a 409 Conflict: another instance is already polling with this bot token. Stop the other instance (old Render deploy, local test, etc.) and redeploy.');
      }
    });
  }

  /** Push a raw message to the configured chat. */
  async notify(text) {
    if (!text) return; // formatters return null for events not worth notifying
    await this.bot.api.sendMessage(this.chatId, text);
  }

  /** Render and send a chart snapshot, with an optional text caption. */
  async sendChart(candles, setup, caption, chartOpts = {}) {
    const buf = renderSetupChart(candles, setup, chartOpts);
    await this.bot.api.sendPhoto(this.chatId, new InputFile(buf, 'chart.png'), caption ? { caption } : undefined);
  }

  /** Push a formatted scanner alert. */
  async notifyScannerAlert(alert) {
    await this.notify(formatScannerAlert(alert));
  }

  /**
   * Drain any new entries from a SetupManager's log and notify on each
   * one. Milestone events (setup created, entry, TP1/TP2, close) get a
   * chart snapshot attached as the caption-bearing photo instead of a
   * plain text message, when `candles` is provided; other events remain
   * plain text. Call this once per candle tick (same cadence as
   * Journal.syncLog — in practice you'd call both together).
   *
   * @param {import('../core/setupManager').SetupManager} setupManager
   * @param {import('../core/swings').Candle[]} [candles] - pass the current candle history to enable chart attachments
   */
  async notifyFromEngine(setupManager, candles) {
    const symbol = setupManager.symbol;
    const startFrom = this._processedLogLength.get(symbol) ?? 0;
    const newEntries = setupManager.log.slice(startFrom);
    const chartsEnabled = await this.settingsStore.get(CHARTS_ENABLED_KEY, true);

    for (const entry of newEntries) {
      const text = formatEngineEvent(entry);
      if (!text) continue;

      if (candles && chartsEnabled && CHART_WORTHY_EVENTS.has(entry.type)) {
        await this.sendChart(candles, setupManager.activeSetup, text, NOTIFICATION_CHART_SIZE);
      } else {
        await this.notify(text);
      }
    }

    this._processedLogLength.set(symbol, setupManager.log.length);
  }
}

module.exports = { TradingBot };
