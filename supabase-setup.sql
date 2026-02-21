-- Run this in Supabase SQL Editor (https://app.supabase.com → SQL Editor)
-- Creates the whale_trades table for persistent trade storage

CREATE TABLE IF NOT EXISTS whale_trades (
  id BIGSERIAL PRIMARY KEY,
  trade_id TEXT UNIQUE NOT NULL,
  instrument_name TEXT NOT NULL,
  direction TEXT NOT NULL,
  amount NUMERIC NOT NULL,
  price NUMERIC,
  timestamp BIGINT NOT NULL,
  btc_price_at_save NUMERIC NOT NULL,
  notional_usd NUMERIC NOT NULL,
  saved_at BIGINT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for fast queries
CREATE INDEX IF NOT EXISTS idx_whale_trades_timestamp ON whale_trades(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_whale_trades_notional ON whale_trades(notional_usd DESC);
CREATE INDEX IF NOT EXISTS idx_whale_trades_trade_id ON whale_trades(trade_id);

-- Enable Row Level Security (required by Supabase)
ALTER TABLE whale_trades ENABLE ROW LEVEL SECURITY;

-- Allow the service role (used by API routes) full access
-- No public access needed since all queries go through our API
CREATE POLICY "Service role full access" ON whale_trades
  FOR ALL USING (true) WITH CHECK (true);
