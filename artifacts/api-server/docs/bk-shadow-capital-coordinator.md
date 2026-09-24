# B-K Shadow Capital Coordinator

Status: **review-only / shadow-only**

This branch does not modify any existing B-K live submit path. The coordinator is not imported by production service entrypoints and no schema initialization is invoked automatically.

## Approved policy encoded here

For services B through K:

```
free_capital =
  fresh same-exchange-index Kalshi available balance
  - same-exchange-index short-lived in-flight reservations

allow iff:
  free_capital >= requested_risk
```

`requested_risk` remains the existing wager principal plus conservative maximum fee headroom supplied by each service.

The shadow formula deliberately excludes:

- A / ETH-martingale future maximum-step reserve;
- the fixed B/C safety reserve;
- persistent unresolved-order risk from `eth_big_bet_orders` merely because local lifecycle state is reserved/submitted/submission_unknown/unsettled.

## In-flight lifecycle

The additive proposed table is `eth_inflight_capital_reservations`.

States:

- `inflight`
- `accepted_pending_refresh`
- `submission_unknown`
- `released`

Active anti-race capital is the sum of the first three states for the **same exchange_index only**.

A cross-process PostgreSQL advisory transaction lock is keyed by exchange index. Under that lock the coordinator:

1. reads a fresh same-shard available balance;
2. sums active same-shard in-flight reservations;
3. computes free capital;
4. creates the in-flight reservation only if free capital covers requested risk.

An accepted order transitions to `accepted_pending_refresh`. The local anti-race reserve is released only after another successful fresh same-shard balance read.

An explicit rejection or authoritative proof of no exchange order may release immediately.

An ambiguous POST transitions to `submission_unknown` and remains fail-closed until authoritative client-order-ID recovery resolves it.

## Shadow-only constraints

- No live B-K runner imports this coordinator.
- No call site invokes `ensureSchema()`.
- No order submission/cancellation code is added.
- No Railway variables/configuration are changed.
- No production migration is performed.
- No strategy signal, sizing, timing, side-selection, kill-switch, daily-loss, duplicate, routing, authentication, or recovery rules are changed.

## Activation work intentionally deferred

A later, separately approved change would need thin service adapters for B-K to:

- call the coordinator immediately before POST;
- emit the structured capital-decision event;
- transition the reservation on accepted/rejected/ambiguous results;
- run startup recovery for `inflight` and `submission_unknown` rows using immutable client-order-ID exchange lookup.

That activation is deliberately out of scope for this review branch.
