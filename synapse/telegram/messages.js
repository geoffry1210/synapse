/**
 * messages.js
 * -----------------------------------------------------------------------
 * Pure formatting functions: take an engine event (from SetupManager's
 * log, or a scanner PumpAlert) and produce Telegram-ready text. Kept
 * dependency-free from grammY so these are trivially unit-testable
 * without a bot instance or network access.
 * -----------------------------------------------------------------------
 */

const { formatAlertMessage } = require('../scanner/scanner');

function fmt(n, decimals = 4) {
  return typeof n === 'number' ? n.toFixed(decimals) : n;
}

/**
 * Format one SetupManager log entry into a Telegram message, or return
 * null for event types that aren't worth notifying about (e.g. internal
 * bookkeeping events).
 *
 * @param {import('../core/setupManager').SetupManager['log'][number]} entry
 * @returns {string|null}
 */
function formatEngineEvent(entry) {
  switch (entry.type) {
    case 'setup_created':
      return (
        `🎯 New ${entry.direction.toUpperCase()} setup — ${entry.symbol}\n` +
        `OB zone: [${fmt(entry.obRange[0])}, ${fmt(entry.obRange[1])}]\n` +
        `Entry: ${fmt(entry.fib.entry)} | SL: ${fmt(entry.fib.sl)}\n` +
        `TP1: ${fmt(entry.fib.tp1)} | TP2: ${fmt(entry.fib.tp2)} | Full: ${fmt(entry.fib.tpFull)}`
      );

    case 'setup_cancelled':
      return `❌ Setup cancelled — ${entry.symbol} (${entry.direction}) — reason: ${entry.reason}`;

    case 'entered_zone':
      return `📍 Price entered OB zone — ${entry.symbol} (${entry.direction}) — watching for confluence`;

    case 'confluence_flag':
      return `✅ Confluence flag: ${entry.flagName} (${entry.bucket}) — ${entry.symbol} (${entry.direction})`;

    case 'trade_entered':
      return (
        `🚀 TRADE ENTERED — ${entry.symbol} (${entry.direction.toUpperCase()})\n` +
        `Entry: ${fmt(entry.entryPrice)} | Size: ${entry.size}\n` +
        `SL: ${fmt(entry.fib.sl)} | TP1: ${fmt(entry.fib.tp1)} | TP2: ${fmt(entry.fib.tp2)} | Full: ${fmt(entry.fib.tpFull)}`
      );

    case 'tp1_hit':
      return `💰 TP1 hit — ${entry.symbol} — 30% closed, SL moved to entry`;

    case 'tp2_hit':
      return `💰 TP2 hit — ${entry.symbol} — 30% of remainder closed`;

    case 'full_close':
      return `🏁 Full close — ${entry.symbol}${entry.reason ? ` (${entry.reason})` : ''}`;

    case 'sl_hit':
      return `🛑 Stop loss hit — ${entry.symbol}`;

    case 'trade_closed':
      return `🛑 Trade closed — ${entry.symbol} (${entry.direction}) — reason: ${entry.reason}`;

    default:
      return null; // e.g. 'ob_not_found' — nothing worth notifying about
  }
}

/**
 * Scanner alerts already have a formatter (scanner/scanner.js); re-export
 * here so the Telegram layer has one place to import all message
 * formatters from.
 */
const formatScannerAlert = formatAlertMessage;

module.exports = { formatEngineEvent, formatScannerAlert };
