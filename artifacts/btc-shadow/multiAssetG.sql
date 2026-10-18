-- Review only. Isolated from BTC and ETH state; no orders submitted.
CREATE TABLE IF NOT EXISTS multi_asset_g_ladders (
 asset TEXT PRIMARY KEY CHECK (asset IN ('SOL','XRP','DOGE')),
 step SMALLINT NOT NULL DEFAULT 0 CHECK (step BETWEEN 0 AND 5),
 pending_order_id TEXT,
 pending_settlement_id TEXT,
 last_settlement_id TEXT,
 version BIGINT NOT NULL DEFAULT 0,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CONSTRAINT multi_asset_g_pending_exclusive CHECK (pending_order_id IS NULL OR pending_settlement_id IS NULL)
);
CREATE TABLE IF NOT EXISTS multi_asset_g_events (
 id BIGSERIAL PRIMARY KEY,
 asset TEXT NOT NULL CHECK (asset IN ('SOL','XRP','DOGE')),
 kind TEXT NOT NULL CHECK (kind IN ('RESERVED','FILLED','ZERO_FILL','WIN','LOSS')),
 order_id TEXT,
 settlement_id TEXT,
 prior_step SMALLINT NOT NULL CHECK (prior_step BETWEEN 0 AND 5),
 next_step SMALLINT NOT NULL CHECK (next_step BETWEEN 0 AND 5),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS multi_asset_g_one_settlement
 ON multi_asset_g_events(asset,settlement_id)
 WHERE settlement_id IS NOT NULL AND kind IN ('WIN','LOSS');
CREATE TABLE IF NOT EXISTS multi_asset_g_order_identity (
 asset TEXT NOT NULL CHECK (asset IN ('SOL','XRP','DOGE')),
 client_order_id TEXT NOT NULL,
 ticker TEXT NOT NULL,
 side TEXT NOT NULL CHECK (side IN ('yes','no')),
 exchange_order_id TEXT,
 verified_filled_contracts INTEGER NOT NULL DEFAULT 0 CHECK (verified_filled_contracts >= 0),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY (asset,client_order_id),
 UNIQUE(asset,exchange_order_id),
 UNIQUE(asset,ticker)
);
INSERT INTO multi_asset_g_ladders(asset) VALUES ('SOL'),('XRP'),('DOGE') ON CONFLICT DO NOTHING;
