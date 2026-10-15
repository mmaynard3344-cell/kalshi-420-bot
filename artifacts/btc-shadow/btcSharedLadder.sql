-- Review migration; must be applied to an approved database before any use.
CREATE TABLE IF NOT EXISTS btc_shared_ladder (
 market TEXT PRIMARY KEY CHECK(market='BTC'),
 step SMALLINT NOT NULL DEFAULT 0 CHECK(step BETWEEN 0 AND 5),
 pending_order_id TEXT,
 pending_settlement_id TEXT,
 last_settlement_id TEXT,
 version BIGINT NOT NULL DEFAULT 0,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CONSTRAINT btc_one_pending CHECK(pending_order_id IS NULL OR pending_settlement_id IS NULL)
);
INSERT INTO btc_shared_ladder(market) VALUES('BTC') ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS btc_shared_ladder_events (
 id BIGSERIAL PRIMARY KEY,
 kind TEXT NOT NULL CHECK(kind IN ('RESERVED','FILLED','ZERO_FILL','WIN','LOSS')),
 order_id TEXT,
 settlement_id TEXT,
 prior_step SMALLINT NOT NULL CHECK(prior_step BETWEEN 0 AND 5),
 next_step SMALLINT NOT NULL CHECK(next_step BETWEEN 0 AND 5),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS btc_ladder_settlement_once ON btc_shared_ladder_events(settlement_id) WHERE settlement_id IS NOT NULL AND kind IN ('WIN','LOSS');

-- Durable exchange identity survives process restarts and is required for
-- authenticated order/fill reconciliation. Do not infer these from a 100-row page.
CREATE TABLE IF NOT EXISTS btc_ladder_order_identity (
 client_order_id TEXT PRIMARY KEY,
 ticker TEXT NOT NULL,
 side TEXT NOT NULL CHECK (side IN ('yes','no')),
 exchange_order_id TEXT UNIQUE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
