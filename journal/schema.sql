-- =========================================================================
-- Trading bot journal schema
-- =========================================================================
-- Five tables, matching the event flow from SetupManager:
--   setups          — every OB identified, its levels, and how it ended
--   confluence_log  — timestamped record of each confluence flag firing
--   trades          — the actual position: entry, sizing, exits, P&L
--   trade_events    — granular lifecycle timeline for each trade
--   bot_settings    — small key/value store for runtime-configurable
--                     values (e.g. weekly trade limit) set via Telegram
-- Designed for Postgres (Railway or Neon) — uses JSONB and generated
-- timestamps.
-- =========================================================================

CREATE TABLE IF NOT EXISTS bot_settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS setups (
  id              BIGSERIAL PRIMARY KEY,
  symbol          TEXT NOT NULL,
  venue           TEXT NOT NULL,               -- 'bybit' | 'weex' | 'mexc' | 'bitget' | 'mt5'
  direction       TEXT NOT NULL CHECK (direction IN ('bullish', 'bearish')),
  ob_low          NUMERIC NOT NULL,
  ob_high         NUMERIC NOT NULL,
  fib_entry       NUMERIC NOT NULL,
  fib_sl          NUMERIC NOT NULL,
  fib_tp1         NUMERIC NOT NULL,
  fib_tp2         NUMERIC NOT NULL,
  fib_tp_full     NUMERIC NOT NULL,
  status          TEXT NOT NULL DEFAULT 'OB_IDENTIFIED',
  -- OB_IDENTIFIED | IN_ZONE_AWAITING_CONFLUENCE | IN_TRADE | MANAGING_EXITS | CLOSED | CANCELLED
  close_reason    TEXT,                        -- 'ob_invalidated' | 'opposing_setup_override' | 'superseded_by_newer_setup' | null
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_setups_symbol_status ON setups (symbol, status);

CREATE TABLE IF NOT EXISTS confluence_log (
  id              BIGSERIAL PRIMARY KEY,
  setup_id        BIGINT NOT NULL REFERENCES setups(id) ON DELETE CASCADE,
  bucket          TEXT NOT NULL CHECK (bucket IN ('mandatory', 'optional')),
  flag_name       TEXT NOT NULL,               -- 'waveTrendDot' | 'mfi' | 'vwap' | 'rsi' | 'stochRsi' | 'frvp' | 'candlePattern'
  fired_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_confluence_setup ON confluence_log (setup_id);

CREATE TABLE IF NOT EXISTS trades (
  id              BIGSERIAL PRIMARY KEY,
  setup_id        BIGINT NOT NULL REFERENCES setups(id) ON DELETE CASCADE,
  symbol          TEXT NOT NULL,
  venue           TEXT NOT NULL,
  direction       TEXT NOT NULL CHECK (direction IN ('bullish', 'bearish')),
  entry_price     NUMERIC NOT NULL,
  size            NUMERIC NOT NULL,
  remaining_size  NUMERIC NOT NULL,
  sl              NUMERIC NOT NULL,
  sl_moved_to_entry BOOLEAN NOT NULL DEFAULT false,
  tp1             NUMERIC NOT NULL,
  tp1_hit         BOOLEAN NOT NULL DEFAULT false,
  tp2             NUMERIC NOT NULL,
  tp2_hit         BOOLEAN NOT NULL DEFAULT false,
  tp_full         NUMERIC NOT NULL,
  status          TEXT NOT NULL DEFAULT 'OPEN', -- OPEN | CLOSED
  pnl             NUMERIC,
  opened_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_trades_symbol_status ON trades (symbol, status);

CREATE TABLE IF NOT EXISTS trade_events (
  id              BIGSERIAL PRIMARY KEY,
  trade_id        BIGINT NOT NULL REFERENCES trades(id) ON DELETE CASCADE,
  event_type      TEXT NOT NULL,               -- 'entry' | 'tp1_hit' | 'tp2_hit' | 'sl_moved_to_entry' | 'full_close' | 'sl_hit'
  data            JSONB,
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_trade_events_trade ON trade_events (trade_id);
