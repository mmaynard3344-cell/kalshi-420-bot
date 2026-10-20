/**
 * DDL for a durable ETH-only target-75 exit journal.
 *
 * IMPORTANT: This migration is deliberately not auto-applied or enabled.
 * The integration must create the table on a disposable database first and
 * test recovery, exact strategy ownership, and settlement semantics.
 */
export const TARGET75_EXIT_DDL = `
CREATE TABLE IF NOT EXISTS eth_target75_exits (
  exit_client_order_id TEXT PRIMARY KEY,
  strategy TEXT NOT NULL,
  ticker TEXT NOT NULL CHECK (ticker ~ '^KXETH[A-Z0-9]*-[A-Z0-9-]+$'),
  entry_order_id TEXT NOT NULL,
  held_side TEXT NOT NULL CHECK (held_side IN ('yes', 'no')),
  requested_contracts INTEGER NOT NULL CHECK (requested_contracts > 0),
  minimum_held_bid_cents INTEGER NOT NULL CHECK (minimum_held_bid_cents BETWEEN 75 AND 99),
  status TEXT NOT NULL CHECK (status IN ('reserved','post_started','submitted','partial','filled','unfilled','unknown','reconciled')),
  provider_order_id TEXT,
  created_at_ms BIGINT NOT NULL,
  updated_at_ms BIGINT NOT NULL,
  UNIQUE (strategy, entry_order_id, exit_client_order_id)
);
CREATE TABLE IF NOT EXISTS eth_target75_exit_fills (
  provider_fill_id TEXT PRIMARY KEY,
  exit_client_order_id TEXT NOT NULL REFERENCES eth_target75_exits(exit_client_order_id),
  provider_order_id TEXT NOT NULL,
  contracts INTEGER NOT NULL CHECK (contracts > 0),
  gross_proceeds_cents BIGINT NOT NULL CHECK (gross_proceeds_cents >= 0),
  fee_cents BIGINT NOT NULL CHECK (fee_cents >= 0),
  observed_at_ms BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS eth_target75_exits_unresolved_idx
 ON eth_target75_exits(status,updated_at_ms)
 WHERE status NOT IN ('unfilled','reconciled');
`;

/**
 * An attempted exchange POST stays fenced until its authenticated status is
 * reconciled. A process restart must not turn post_started into an unused slot.
 */
export function target75MaySubmit(status: string | null): boolean {
  return status === null;
}
export function target75NeedsReconciliation(status: string): boolean {
  return ["post_started","submitted","partial","filled","unknown"].includes(status);
}
