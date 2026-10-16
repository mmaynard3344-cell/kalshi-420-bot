# Shared ETH martingale — integration gate (review only)

No runtime registration or trading toggles in this branch.

## Confirmed decision
Whichever eligible ETH strategy (A–L, where enabled) fires first claims the shared ladder. Its own YES/NO selection wins; a competing signal must be skipped. USD and BTC remain independent.

## One atomic ledger (required before live use)
Use a durable Postgres state row with `step`, `active_claim_id`, `version`, and last applied settlement ID, plus a journal recording claim ID, service, market ticker, requested/filled contracts, costs, fees and outcome. Acquire an advisory lock / row lock in a transaction to compare-and-set `active_claim_id IS NULL`. The unique claim must cover *all* ETH services and remain reserved through settlement. Reject submissions not holding that claim. Do not let process-local locks substitute for DB atomicity, especially across multiple Railway services.

## Required state changes
- Reserved but not submitted: verified failure releases reservation without step change.
- Submitted/open: claim persists until authenticated exchange order and market settlement are reconciled.
- No fill: remain on same step. Partial fill: wait until the remainder is terminal; derive outcome from actual filled quantity and settlement.
- Win: reset to step 0. Loss: advance 1; after losing step 5 reset to 0 under user-specified six-step cap.
- If result/fee/fill/position is uncertain, freeze claim and do not place another ETH trade.
- Settlement must be idempotent with unique settlement key and transactional version guard.
- A service that fires while a claim is held must skip without queueing a trade for later.
- Enforce budget using exchange price and estimated fees, including partial fills. At most one shared ETH claim/order across services.

## Integration tasks before any merge/enable
1. Inventory *all* live ETH Railway executors, including independent G and the older A engine. Identify each actual order submission path; enforce shared claim at the last common pre-submit boundary or explicitly bridge every runtime.
2. Create schema migrations + rollback, test with disposable non-production Postgres.
3. Add concurrency tests for two simultaneous different services, crash/restart recovery, double settlement, delayed settlement, partial fills, zero fills, insufficient funds, fee rounding and stake cap.
4. Verify model against historical order IDs and actual exchange settlements without live orders.
5. Typecheck, run unit/integration tests and prepare a review PR. Do not merge, deploy, or enable execution without user approval and green checks.

These pure transition functions are **not** an execution interlock by themselves.
