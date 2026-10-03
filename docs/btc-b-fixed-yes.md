# BTC B — fixed YES, $5

The BTC addition runs alongside ETH. The user's final instruction is to make
BTC B always choose YES. BTC A is excluded. K stays on weather; the new BTC L
remains shadow-only. Other new BTC strategies use $5 stakes.

This patch prepares BTC B's signal and order intent independently of A:

- Markets: KXBTC15M only.
- Side: always YES, including qualifying downward jumps.
- Principal: 500 cents, flat; no ladder or time-based multiplier.
- Limit: 50 cents, preserving B's existing entry limit.
- Trigger: p95 <= absolute adjacent floor-strike return < p99.
- Percentiles: finalized BTC history strictly preceding the target window,
  within the trailing 28 days. Preserve B's 50-return minimum sample.
- Skip missing immediate predecessor, invalid/conflicting history, insufficient
  history, and moves outside the jump band. Ignore unfinished, future-known,
  current-window, and ETH observations. Gaps are never treated as adjacent moves.
- Order tag: btc-jump-fixed-yes-v1, distinct from ETH B.

`prepareBtcJumpIntent` is read-only. It does not poll, submit, reserve funds,
write a database, or change the ETH runtime. The directional model and its
extra eligibility gates were removed following the user's fixed-YES instruction.

Validation: the dedicated test runner and API server typecheck.

Status: signal/intent patch only, not deployed or live. The BTC service still
needs its market/history collector, durable execution and reconciliation,
account guard integration, and dashboard attribution before it can trade.
The remaining BTC service additions are also not deployed by this patch.
