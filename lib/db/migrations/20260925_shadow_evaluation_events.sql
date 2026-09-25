CREATE TABLE IF NOT EXISTS shadow_evaluation_events (
  id BIGSERIAL PRIMARY KEY,
  service TEXT NOT NULL CHECK (service IN ('A2', 'L')),
  evaluated_at_ms BIGINT NOT NULL,
  ticker TEXT,
  market_open_time_ms BIGINT,
  decision TEXT NOT NULL CHECK (decision IN ('no_signal', 'qualified', 'error')),
  primary_reason TEXT,
  would_submit BOOLEAN NOT NULL DEFAULT FALSE,
  evidence_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  evaluation_interval_ms BIGINT NOT NULL CHECK (evaluation_interval_ms > 0),
  runtime_version TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (decision = 'qualified' OR would_submit = FALSE)
);

CREATE INDEX IF NOT EXISTS idx_shadow_evaluation_events_service_time
  ON shadow_evaluation_events (service, evaluated_at_ms DESC);

CREATE INDEX IF NOT EXISTS idx_shadow_evaluation_events_service_decision_time
  ON shadow_evaluation_events (service, decision, evaluated_at_ms DESC);
