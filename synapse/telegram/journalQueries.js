/**
 * journalQueries.js
 * -----------------------------------------------------------------------
 * Read-only queries against the journal schema (see journal/schema.sql),
 * plus formatters turning the results into Telegram-ready text. Takes
 * any pool-like object with an async `.query(sql, params)` method, same
 * as Journal — so these are testable with the same mock pool pattern.
 * -----------------------------------------------------------------------
 */

async function getRecentTrades(pool, limit = 10) {
  const { rows } = await pool.query(
    `SELECT symbol, venue, direction, entry_price, size, status, pnl, opened_at, closed_at
     FROM trades ORDER BY opened_at DESC LIMIT $1`,
    [limit]
  );
  return rows;
}

async function getJournalForSymbol(pool, symbol, limit = 20) {
  const { rows: setups } = await pool.query(
    `SELECT id, direction, status, close_reason, fib_entry, fib_sl, fib_tp1, fib_tp2, fib_tp_full, created_at, closed_at
     FROM setups WHERE symbol = $1 ORDER BY created_at DESC LIMIT $2`,
    [symbol, limit]
  );
  return setups;
}

async function getStats(pool) {
  const { rows } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'CLOSED') AS closed_count,
       COUNT(*) FILTER (WHERE status = 'CLOSED' AND pnl IS NOT NULL) AS scored_count,
       COUNT(*) FILTER (WHERE status = 'CLOSED' AND pnl > 0) AS wins,
       COUNT(*) FILTER (WHERE status = 'CLOSED' AND pnl <= 0) AS losses,
       AVG(pnl) FILTER (WHERE status = 'CLOSED') AS avg_pnl,
       COUNT(*) FILTER (WHERE status = 'OPEN') AS open_count
     FROM trades`
  );
  return rows[0];
}

function formatTradesList(trades) {
  if (trades.length === 0) return 'No trades yet.';
  return trades
    .map((t) => {
      const status = t.status === 'OPEN' ? '🟢 OPEN' : '⚪ CLOSED';
      const pnlStr = t.pnl !== null ? ` | PnL: ${t.pnl}` : '';
      return `${status} ${t.symbol} (${t.venue}) ${t.direction} @ ${t.entry_price} x${t.size}${pnlStr}`;
    })
    .join('\n');
}

function formatJournal(symbol, setups) {
  if (setups.length === 0) return `No setups found for ${symbol}.`;
  const lines = setups.map((s) => {
    return (
      `[${s.status}] ${s.direction}${s.close_reason ? ` (${s.close_reason})` : ''}\n` +
      `  entry=${s.fib_entry} sl=${s.fib_sl} tp1=${s.fib_tp1} tp2=${s.fib_tp2} full=${s.fib_tp_full}`
    );
  });
  return `📔 Journal — ${symbol}\n\n${lines.join('\n\n')}`;
}

function formatStats(stats) {
  const closed = Number(stats.closed_count) || 0;
  const scored = Number(stats.scored_count) || 0;
  const wins = Number(stats.wins) || 0;
  const losses = Number(stats.losses) || 0;
  const open = Number(stats.open_count) || 0;
  const avgPnl = stats.avg_pnl !== null ? Number(stats.avg_pnl).toFixed(2) : 'n/a';
  const winRate = scored > 0 ? ((wins / scored) * 100).toFixed(1) : 'n/a';

  return (
    `📊 Stats\n` +
    `Open trades: ${open}\n` +
    `Closed trades: ${closed}${scored < closed ? ` (${closed - scored} missing PnL data)` : ''}\n` +
    `Win rate: ${winRate}${winRate !== 'n/a' ? '%' : ''} (${wins}W / ${losses}L)\n` +
    `Avg PnL: ${avgPnl}`
  );
}

module.exports = {
  getRecentTrades,
  getJournalForSymbol,
  getStats,
  formatTradesList,
  formatJournal,
  formatStats,
};
