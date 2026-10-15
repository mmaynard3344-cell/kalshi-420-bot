# BTC B–L six-step ladder — release gate

Source production branch: `deploy/btc-b-l-one-dollar-20261013`. This review branch is not deployed.

Observed BTC runner (`artifacts/btc-shadow/index.mjs`): in-memory `activeOrders`, fixed `STAKE_CENTS=100`, deterministic client order IDs, IOC orders, and exchange fill/settlement lookups via `reconcileRecentOrders`. The runner has no durable global market-level reservation or settlement ledger.

**BLOCK PRODUCTION ACTIVATION until:**

1. Use one durable PostgreSQL market row for BTC, with serializable/row-locked reservation shared across ALL BTC B–L order writers. Keep USD/ETH separate.
2. Implement the ladder in this deployed runtime (the review PR #52 TypeScript modules are not present here; a standalone `.mjs` service cannot import them unchanged).
3. Reserve before HTTP POST; fail closed if DB is unavailable; release only after authenticated confirmation of zero fills. Unknown/partial fills must retain reservation.
4. Reconcile actual exchange fills, market result, fees, and final order status; transition precisely once to next step, including replay after restart. Never infer loss from a timeout.
5. Resolve the BTC order semantics for NO side (currently bid YES versus ask YES) and account shard before enabling larger wagers.
6. End-to-end disposable database tests: concurrent B–L signals, different service replicas, timeouts, zero fills, partial fills, duplicate and out-of-order settlements, crash/restart, insufficient funds, and one-bet total including fees.
7. Verify service branch, start command, config flags, exchange shard, funding, logs and recorded fills in Railway/Kalshi after a $1-only canary.
8. Enable $2/$4/$8/$16/$32 ladder only after user-reviewed verification; six losses total $63 per market before additional costs.

No production changes are authorized by the presence of this document.
