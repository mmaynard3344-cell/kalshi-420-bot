# Service B shared ETH ladder integration — review-only

This branch is forked from Railway B source `refactor/railway-wager-b`. The shared ETH modules and PostgreSQL adapter are staged but NOT called by B's live order executor.

## Confirm exact runtime submission boundary first
The `ethOnlyMartingale.ts` module has a durable local reservation and `markEthMartingaleOrderPostStarted` immediately preceding `authFetch("POST", "/portfolio/events/orders", payload)`. This is a legacy A-style path and **must not be assumed to be B's live submission path**. Locate the B Jump strategy's actual Kalshi POST in its running production command and wire only that path.

## Required cutover
- Acquire global ETH claim using `submitThroughSharedEthGate` before order POST. Keep the strategy's selected YES/NO direction.
- Compute wager with `ethContractsWithinBudget`; never use the B service's old stake amount once shared mode is activated.
- Correlate shared claim, client order ID, and authenticated exchange order ID in durable storage.
- Hold claim until authoritative terminal status plus final fills and market settlement; zero-fill leaves step unchanged.
- Add end-to-end disposable-Postgres tests, compile the actual B entrypoint, and confirm no bypass when the shared feature is enabled.
- Do not enable on Railway until **every** enabled ETH executor has the same interlock, with an all-or-nothing cutover. BTC and USD excluded.

No production behavior changes are made by the review branch.
