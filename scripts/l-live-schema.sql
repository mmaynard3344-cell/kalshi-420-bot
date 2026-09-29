BEGIN;
CREATE TABLE IF NOT EXISTS eth_long_reversal_reservations (
  id text PRIMARY KEY,
  bucket text NOT NULL,
  service text NOT NULL,
  strategy text NOT NULL,
  ticker text NOT NULL,
  client_order_id text NOT NULL,
  source_order_id text,
  exchange_index integer NOT NULL,
  requested_risk_cents integer NOT NULL,
  active_risk_cents integer NOT NULL,
  filled_contracts double precision,
  actual_notional_cents integer,
  actual_fee_cents integer,
  last_adjustment_reason text,
  state text NOT NULL,
  created_at_ms bigint NOT NULL,
  updated_at_ms bigint NOT NULL,
  created_at timestamp DEFAULT now(),
  updated_at timestamp DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS eth_long_reversal_client_order_uq ON eth_long_reversal_reservations(client_order_id);
CREATE INDEX IF NOT EXISTS eth_long_reversal_active_idx ON eth_long_reversal_reservations(bucket,state,created_at_ms);
CREATE INDEX IF NOT EXISTS eth_long_reversal_service_idx ON eth_long_reversal_reservations(service,state);
CREATE TABLE IF NOT EXISTS sweep_reclaim_claims (
  id text PRIMARY KEY,
  strategy_id text NOT NULL,
  service_code text NOT NULL,
  display_label text NOT NULL,
  source_venue text NOT NULL,
  source_candle_open_ms bigint NOT NULL,
  source_candle_close_ms bigint NOT NULL,
  source_open double precision NOT NULL,
  source_high double precision NOT NULL,
  source_low double precision NOT NULL,
  source_close double precision NOT NULL,
  prior_24h_low double precision NOT NULL,
  candle_range double precision NOT NULL,
  real_body double precision NOT NULL,
  lower_wick double precision NOT NULL,
  midpoint double precision NOT NULL,
  close_position_fraction double precision NOT NULL,
  swept_previous_24h_low boolean NOT NULL,
  wick_condition boolean NOT NULL,
  upper_half_close boolean NOT NULL,
  qualified boolean NOT NULL,
  destination_ticker text NOT NULL,
  side text NOT NULL DEFAULT 'yes',
  observed_yes_price_cents integer,
  configured_price_cap_cents integer,
  requested_contracts integer,
  requested_risk_cents integer,
  correlated_exposure_before_cents integer,
  proposed_exposure_cents integer,
  shared_exposure_cap_cents integer,
  admission_outcome text,
  rejection_reason text,
  lifecycle_state text NOT NULL DEFAULT 'CLAIMED',
  client_order_id text,
  kalshi_order_id text,
  filled_contracts double precision,
  average_fill_price_cents integer,
  actual_fee_cents integer,
  settlement_result text,
  realized_pnl_cents integer,
  claimed_at_ms bigint NOT NULL,
  updated_at_ms bigint NOT NULL,
  created_at timestamp DEFAULT now(),
  updated_at timestamp DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS sweep_reclaim_claim_identity_uq ON sweep_reclaim_claims(strategy_id,source_candle_open_ms,destination_ticker);
CREATE INDEX IF NOT EXISTS sweep_reclaim_claims_destination_idx ON sweep_reclaim_claims(destination_ticker);
CREATE INDEX IF NOT EXISTS sweep_reclaim_claims_source_open_idx ON sweep_reclaim_claims(source_candle_open_ms);
CREATE INDEX IF NOT EXISTS sweep_reclaim_claims_state_idx ON sweep_reclaim_claims(lifecycle_state);
SELECT id,strategy_id,source_candle_open_ms,destination_ticker,lifecycle_state,
  client_order_id,kalshi_order_id,filled_contracts,average_fill_price_cents,actual_fee_cents,
  settlement_result,realized_pnl_cents FROM sweep_reclaim_claims LIMIT 0;
SELECT id,bucket,service,source_order_id,client_order_id,exchange_index,
  requested_risk_cents,active_risk_cents,state FROM eth_long_reversal_reservations LIMIT 0;
COMMIT;
