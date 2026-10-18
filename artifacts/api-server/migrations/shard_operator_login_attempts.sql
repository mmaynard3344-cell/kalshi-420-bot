-- Apply only after review, before enabling SHARD_OPERATOR_LOGIN_ENABLED.
-- Shared across API replicas; hashes avoid storing client identifiers.
CREATE TABLE IF NOT EXISTS shard_operator_login_attempts (
 identity_hash VARCHAR(64) PRIMARY KEY,
 window_start_ms BIGINT NOT NULL,
 attempts INTEGER NOT NULL CHECK (attempts > 0)
);
