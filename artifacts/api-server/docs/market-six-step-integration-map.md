# Six-step ladder production integration map (review only)

This was derived from Railway production service-source settings on 2026-10-14/15. Do not assume a PR merged to one branch reaches all execution services.

## Three shared state domains
- BTC: all B–L strategies must reserve/settle through the BTC database ladder.
- ETH: all B–L strategies must reserve/settle through the ETH database ladder.
- EURUSD: the standalone Railway Function must use the EURUSD shared state, not only its local SQLite store.

## Confirmed distinct production sources
- `kalshi-420-bot` → `service-split-a-b-c`
- `eth-jump-service` → `refactor/railway-wager-b`
- `eth-reversal-service` → `refactor/railway-wager-c`
- `eth-breakout-reversal` → `refactor/railway-wager-d`
- `eth-downfade-e`, `eth-downfade-f` → `refactor/railway-wager-ef`
- `eth-downfade-g` → `deploy/eth-g-one-dollar-20261013`
- `Ashley` → `refactor/railway-wager-h`
- `Ash V2` → `refactor/railway-wager-i`
- `BTC B-L Shadow $5` → `deploy/btc-b-l-one-dollar-20261013` (name includes Shadow; actual execution eligibility must be verified)
- `EURUSD Strategy A $1 Pilot DISABLED` → standalone Railway Function, not GitHub deployed

## Required activation gate
1. Enumerate every enabled execution service and every strategy contributing to market B–L.
2. Standardize on durable transaction methods in `marketSharedLadderStore.ts`, applying the schema via an approved migration.
3. Each order writer: reserve and commit a unique step before POST; one active order per market globally; price/fees <= step limit; rejected/ambiguous responses must be reconciled.
4. Each filler: confirm exact order ID and filled amount; partial fills and orders with ambiguous terminal status cannot be released as zero-fill.
5. Each settler: obtain exchange-confirmed market result and settlement economics, idempotently commit outcome and next step in same transaction.
6. EURUSD needs PostgreSQL coordination or another cross-service compatible durable store; SQLite in its own Railway volume is not sufficient for shared portfolio state.
7. Test concurrent orders from different branches/services, redeploys, zero fills, partial fills, unknown acknowledgments, out-of-order settlement replay, and missing shard balance.
8. Run project build/typecheck/full suite, and explicitly review risk limits, especially the $32 last-step stake and $63 six-loss cycle.
9. Deploy staged one market at a time and verify live exchange fills/settlements before expansion.

This document is a review checklist, not proof of live integration.
