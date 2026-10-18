-- ETH G v2 isolated state. Review only; apply after disposable DB tests.
CREATE TABLE IF NOT EXISTS eth_g_v2_state (
 id INTEGER PRIMARY KEY DEFAULT 1 CHECK(id=1),
 step SMALLINT NOT NULL DEFAULT 0 CHECK(step BETWEEN 0 AND 5),
 pending_client_order_id TEXT,
 last_settlement_id TEXT,
 last_trigger_key TEXT,
 version BIGINT NOT NULL DEFAULT 0,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS eth_g_v2_orders (
 client_order_id TEXT PRIMARY KEY,
 ticker TEXT NOT NULL CHECK(ticker LIKE 'KXETH15M-%'),
 side TEXT NOT NULL CHECK(side IN ('yes','no')),
 exchange_order_id TEXT UNIQUE,
 verified_filled_contracts INTEGER NOT NULL DEFAULT 0 CHECK(verified_filled_contracts >= 0),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS eth_g_v2_settlements (
 settlement_id TEXT PRIMARY KEY,
 client_order_id TEXT NOT NULL UNIQUE REFERENCES eth_g_v2_orders(client_order_id),
 outcome TEXT NOT NULL CHECK(outcome IN ('win','loss')),
 previous_step SMALLINT NOT NULL,
 next_step SMALLINT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO eth_g_v2_state(id) VALUES(1) ON CONFLICT DO NOTHING;
