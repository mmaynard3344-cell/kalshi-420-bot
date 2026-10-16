-- REVIEW ONLY. Apply to disposable non-production Postgres first.
-- The state row is the single serialization point across all ETH processes.
BEGIN;
CREATE TABLE IF NOT EXISTS eth_shared_martingale_state (
 singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
 step SMALLINT NOT NULL DEFAULT 0 CHECK (step BETWEEN 0 AND 5),
 active_claim_id UUID UNIQUE,
 version BIGINT NOT NULL DEFAULT 0,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO eth_shared_martingale_state(singleton) VALUES(TRUE)
ON CONFLICT(singleton) DO NOTHING;
CREATE TABLE IF NOT EXISTS eth_shared_martingale_claims (
 claim_id UUID PRIMARY KEY,
 service TEXT NOT NULL,
 ticker TEXT NOT NULL,
 side TEXT NOT NULL CHECK (side IN ('yes','no')),
 step SMALLINT NOT NULL CHECK (step BETWEEN 0 AND 5),
 budget_cents INTEGER NOT NULL CHECK (budget_cents IN (100,200,400,800,1600,3200)),
 status TEXT NOT NULL DEFAULT 'RESERVED' CHECK (status IN ('RESERVED','SUBMITTED','SETTLED','ZERO_FILL','RELEASED')),
 order_id TEXT UNIQUE,
 outcome TEXT CHECK (outcome IN ('WIN','LOSS','ZERO_FILL')),
 settlement_id TEXT UNIQUE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 resolved_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS eth_shared_martingale_claims_created
 ON eth_shared_martingale_claims(created_at DESC);
COMMIT;

-- Atomic FIRST CLAIM: use with a generated unique UUID and one shared Postgres DB.
-- One SQL transaction must lock state before trying INSERT+UPDATE:
-- BEGIN;
-- SELECT step,active_claim_id,version FROM eth_shared_martingale_state
--  WHERE singleton=TRUE FOR UPDATE;
-- If active_claim_id IS NOT NULL: ROLLBACK, skip signal.
-- INSERT INTO eth_shared_martingale_claims ... using selected step + budget.
-- UPDATE eth_shared_martingale_state SET active_claim_id=$claim_id,
-- version=version+1,updated_at=NOW() WHERE singleton=TRUE;
-- COMMIT;
-- Settle: row-lock state and claim; validate active claim, settlement id and
-- authenticated exchange fills/result; CAS idempotently and update step.
-- Never treat a lease timeout as permission to re-use a submitted claim.
