# Add SOL G, XRP G and DOGE G (review / not live)

## Verified Kalshi series
- SOL: `KXSOL15M`
- XRP: `KXXRP15M`
- DOGE: `KXDOGE15M`

## Required functional behavior
- Reuse BTC G's **exact-two** settlement-reversal trigger: oldest-to-newest pattern opposite, same, same. Enter the opposite of the two repeated outcomes in the following 15-minute market. Never infer outcomes from price movement or missing settlements.
- Each asset has a completely independent six-step ladder, settlement cursor, pending claim, and order idempotency key: **$2, $4, $8, $16, $32, $64**. Win resets to Step 1; verified loss advances a step. No shared ladder between different assets or with BTC.
- Reuse the verified **direct ticker GET** market-discovery approach and verify close-time windows in America/New_York. Confirm each series' actual market schema, precision and outcome history on Kalshi before placing orders.
- Fail closed if current market is not valid/active, outcome history incomplete, status/price ambiguous, balances insufficient, or an order is pending/unreconciled. No fallback to another asset.
- Exchange shard selection, GTC behavior, contracts, fees, and settlement reconciliation must be independently validated, as BTC-specific hard-coded keys/tables currently exist in `artifacts/btc-shadow/`.
- Keep `TRADING_ENABLED=false` and `ORDER_EXECUTION_ENABLED=false` for all three new services until approved and end-to-end tests pass. **This document is not a trading implementation**.
- Supply test evidence for each asset: exact market discovery, zero/one/multiple current matches, three finalized outcomes, no-fire cases, exactly-once order submission, verified fill/zero-fill, win/loss advance, crash recovery, stuck order alert, six-step cap, cross-asset isolation.
- Add them to Shawshank dashboard with explicit attribution and health state per asset before live activation.

## Risk
Maximum six-step cumulative stakes: $126 per asset, $378 across SOL/XRP/DOGE if all lose every rung. These are additional exposures beyond existing BTC and ETH positions. Fees and spreads could further affect net P&L.

## Deployment gate
Do not merge/deploy/enable until real Kalshi current-market and settlement data for every series have been checked and targeted tests plus existing CI succeed. Roll out one asset at a time with explicit live-order confirmation.
