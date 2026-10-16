-- REVIEW ONLY: Apply only after coordinated ETH cutover approval.
-- Durable correlation between one B claim and its Kalshi client/exchange order.
CREATE TABLE IF NOT EXISTS eth_b_shared_claim_links (
 claim_id UUID PRIMARY KEY REFERENCES eth_shared_martingale_claims(claim_id),
 client_order_id TEXT NOT NULL UNIQUE,
 ticker TEXT NOT NULL,
 side TEXT NOT NULL CHECK (side IN ('yes','no')),
 exchange_order_id TEXT,
 requested_contracts INTEGER NOT NULL CHECK (requested_contracts > 0),
 created_at_ms BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS eth_b_shared_exchange_order_uidx
 ON eth_b_shared_claim_links(exchange_order_id)
 WHERE exchange_order_id IS NOT NULL;
