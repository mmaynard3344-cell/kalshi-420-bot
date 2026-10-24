# ETH live execution integration inventory — review only

Checked 2026-10-16 against Railway production service configuration and GitHub branches.

## Important: shared martingale is NOT wired to live order submissions

The database claim store on this review branch has no live callers. Its green disposable PostgreSQL tests prove ledger serialization, not that live orders are serialized. Production cannot be safely enabled by changing a toggle.

## Known separately deployed ETH entry points

| ETH role | Railway service | Source branch / command |
| --- | --- | --- |
| A | kalshi-420-bot | service-split-a-b-c / run-production-with-research-worker.mjs |
| B | eth-jump-service | refactor/railway-wager-b / run-production-with-research-worker.mjs |
| E | eth-downfade-e | refactor/railway-wager-ef / run-production-with-research-worker.mjs |
| F | eth-downfade-f | refactor/railway-wager-ef / run-production-with-research-worker.mjs |
| G | eth-downfade-g | deploy/eth-g-one-dollar-20261013 / dist/g4060ScalpIndex.mjs |
| H | Ashley | refactor/railway-wager-h / dist/ashley.mjs |
| I | Ash V2 | refactor/railway-wager-i / separately deployed process |

Other C, D, J, K, L and legacy processes must be checked for enabled live order paths before cutover.

## Verified independent G order submission

The live G branch at `artifacts/api-server/src/g4060ScalpIndex.ts` has `submitOrder` calling `kalshiAuthFetch("POST", "/portfolio/events/orders", ...)` with `time_in_force: "good_till_canceled"` and local `PRINCIPALS_CENTS[step]`. Its local duplicate check is per ticker, not a cross-service claim. **This code is not yet protected by the shared ETH ledger.**

## Minimum cross-service cutover requirements

1. Every enabled ETH process must use one shared transaction provider and `claimFirstEthSignal` immediately before exchange submission.
2. Derive principal/contract count from the claimed `budgetCents`, not each service's local ladder; enforce fee-inclusive risk budget. Direction remains the winning signal's side.
3. Persist an exchange-correlatable client order ID **before** network submission; timeout/unknown response cannot release claim. Recover from Kalshi order history on restart.
4. Use an authenticated exchange terminal state and settlement proof, preserving partial-fill exposure until fully reconciled, before `finalizeEthClaim`.
5. G's GTC resting order and any other resting-order paths must remain locked until terminal, not just until the 15-minute signal window ends.
6. Use global feature-gate off by default; deploy identical interlock support to every service; verify all processes and migrations before enabling the shared feature. Unprotected services must not continue submitting ETH orders after cutover.
7. Prove no impact on independently deployed BTC and USD.
8. Verify operational kill switch and recovery before a live pilot.

Do not deploy this review-only claim store as a claim of production-wide protection.
