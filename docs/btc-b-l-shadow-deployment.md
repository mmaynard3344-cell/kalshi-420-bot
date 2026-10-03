# BTC B–L shadow deployment

This is a new isolated service alongside ETH, using public BTC market data. All
BTC hypothetical stakes are $5 (500 cents), flat, with no morning multiplier or
loss progression. No real-money orders or simulated fills are placed. No
credentials, account requests, production database, or authenticated order
client is present in the deployed import graph. Environment flags cannot turn
order execution on.

| Service | BTC rule |
|---|---|
| B | Always YES when p95 <= absolute adjacent strike return < p99. No A dependency. |
| C | YES after at least three immediately preceding NO results, within the jump band. |
| D | YES after at least three NO results, within the upper half of the jump band. |
| E | YES on a downward move in p80–p90. |
| F | YES on a downward move in p90–p95. |
| G | Opposite exactly two consecutive equal outcomes; exclude a third matching outcome. |
| H | YES on a decline >=0.70% and <0.95%. |
| I | YES on a decline >=0.60% and <0.99%; NO on a rise >=0.50% and <0.80%. |
| J | Requires a verified same-market BTC A paper order, zero fill, resting/open status, no depth at 50c, and ask >50c and <=90c. No BTC A is running, so J waits. It never reads/cancels ETH A orders. |
| K | Excluded: the weather strategy stays on weather. |
| L | YES following a completed BTC candle that sweeps the preceding 96-candle low, has lower wick >=body, and closes at/above its midpoint. Exactly the immediately following market. |

Every percentile is computed from finalized BTC-only adjacent strike returns
strictly before the target market, within the trailing 28 days; preserve the
deployed 50-return minimum. Future-known facts, unfinished markets, current
window facts, gaps, and conflicting history fail closed or are excluded.
L uses completed Kraken XBTUSD 15-minute candles and excludes its trigger candle
from the prior 24-hour history. A provider failure is visible and blocks L.
H/I percentage thresholds are preserved as requested; they are not newly
optimized or validated for BTC.

The service reports evaluations and distinct qualifying windows. Counts are
since process start and reset on restart. Signals are neither exchange fills
nor profit measurements. The long-reversal correlation group is labeled for
E/H/I-YES/L; no exposure is created or capital reserved in shadow mode.

## Source baselines

- B: `3d36726e0578b4e6a78cd0968771c4da1f8ade90`, with the user's fixed YES override.
- C: `26f257e274f566730e82bf6a5a58e695f4751c12`.
- D: `refactor/railway-wager-d` (`ethBreakoutReversal.ts`).
- E/F: `85ce9cf45ea05b5e2c6ecabb40180629a0f84e15`.
- G: `c5ccd4aebbdf1b691a329916fd40dfa6e7c7b0a4`, including the deployed exact-two/no-loss-progression patch.
- H: `a5c8b1ad2cf69e719539a50002cd30ef487ac1ef`.
- I: `d661b26b78f5c0d2672df0f4d17ea4d5f0de1a1c`.
- J: `3eaf08b8fd3fd1f060c4049f48fe5d3a64852124`.
- L: `fix/l-live-execution` (`sweepReclaimV1.ts`).

## Verification and operation

`node --test artifacts/btc-shadow/signals.test.mjs` tests all service rules,
boundaries, history isolation, completed candles, market identity, GET-only
networking, missing dependencies, and execution isolation.
`node artifacts/api-server/scripts/run-btc-jump-signal-test.mjs` verifies the
reused B signal and intent. API TypeScript checks also pass.

The Docker image contains only the native Node runtime and four local modules;
there is no dependency installation or executable legacy ETH application.
`/health` verifies fresh successful BTC evaluations. `/status` exposes individual
service reasons. `/` is a mobile status page. This deployment uses its own Git
branch and Railway service; it does not merge into or redeploy ETH services.
