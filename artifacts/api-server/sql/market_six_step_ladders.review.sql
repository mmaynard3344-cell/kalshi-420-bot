-- REVIEW ONLY: do not apply to production until all order writers use this ledger.
-- Three independently locked market ladders. One unresolved order per market.
CREATE TABLE IF NOT EXISTS market_six_step_ladders (
 market TEXT PRIMARY KEY CHECK (market IN ('BTC','ETH','EURUSD')),
 step SMALLINT NOT NULL DEFAULT 0 CHECK (step BETWEEN 0 AND 5),
 pending_order_id TEXT,
 pending_settlement_id TEXT,
 last_settlement_id TEXT,
 version BIGINT NOT NULL DEFAULT 0,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 CONSTRAINT single_pending CHECK (pending_order_id IS NULL OR pending_settlement_id IS NULL)
);
INSERT INTO market_six_step_ladders(market) VALUES ('BTC'),('ETH'),('EURUSD')
ON CONFLICT (market) DO NOTHING;
CREATE TABLE IF NOT EXISTS market_six_step_events (
 event_id BIGSERIAL PRIMARY KEY,
 market TEXT NOT NULL REFERENCES market_six_step_ladders(market),
 exchange_order_id TEXT,
 settlement_id TEXT,
 transition TEXT NOT NULL CHECK (transition IN ('RESERVED','FILLED','CANCELLED_ZERO_FILL','WIN','LOSS')),
 prior_step SMALLINT NOT NULL CHECK (prior_step BETWEEN 0 AND 5),
 next_step SMALLINT NOT NULL CHECK (next_step BETWEEN 0 AND 5),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS market_six_step_settlement_once
 ON market_six_step_events(market,settlement_id)
 WHERE settlement_id IS NOT NULL AND transition IN ('WIN','LOSS');
-- Integration contract:
-- BEGIN; SELECT * FROM market_six_step_ladders WHERE market=$1 FOR UPDATE;
-- Reject if either pending field is set.
-- Reserve before order submission and commit the reservation transaction.
-- An uncertain order MUST remain reserved until reconciled with exchange.
-- Transition FILLED only after verified fill; settle WIN/LOSS only after
-- exchange settlement against that order; update state + event atomically.
-- Do not determine WIN/LOSS from simulated predictions.
