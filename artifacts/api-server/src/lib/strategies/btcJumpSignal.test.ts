import assert from "node:assert/strict";
import test from "node:test";
import { prepareBtcJumpIntent } from "./btcJumpServiceRuntime.js";
import {
  BTC_B_HISTORY_MS, BTC_B_WINDOW_MS, evaluateBtcJump,
  type BtcJumpFact, type BtcJumpMarket,
} from "./btcJumpSignal.js";

const start = 1_800_000_000_000; // exact 15-minute boundary
function fixture() {
  const history: BtcJumpFact[] = [];
  let floorStrike = 60_000;
  for (let i = 0; i <= 250; i++) {
    if (i > 0) floorStrike *= 1 + i / 100_000;
    const openTimeMs = start + i * BTC_B_WINDOW_MS;
    history.push({ ticker: `KXBTC15M-H${i}`, openTimeMs, floorStrike, finalized: true,
      finalizedAtMs: openTimeMs + BTC_B_WINDOW_MS });
  }
  const prior = history.at(-1)!;
  const market: BtcJumpMarket = { ticker: "KXBTC15M-CURRENT", openTimeMs: prior.openTimeMs + BTC_B_WINDOW_MS,
    observedAtMs: prior.openTimeMs + BTC_B_WINDOW_MS + 1000, floorStrike: prior.floorStrike * 1.00242 };
  return { history, market };
}

test("BTC B buys YES on either signed jump without A state at $5", () => {
  for (const sign of [1, -1]) {
    const input = fixture();
    input.market.floorStrike = input.history.at(-1)!.floorStrike * (1 + sign * 0.00242);
    const decision = evaluateBtcJump(input);
    assert.equal(decision.fires, true);
    assert.equal(decision.side, "yes");
    assert.equal(decision.wagerCents, 500);
    assert.equal(decision.historyMoveCount, 250);
  }
});
test("BTC B prepares a distinct fixed-YES $5 intent only for a qualifying BTC jump", () => {
  const input = fixture();
  assert.deepEqual(prepareBtcJumpIntent(input).intent, {
    strategy: "jump", orderTag: "btc-jump-fixed-yes-v1", ticker: input.market.ticker,
    side: "yes", wagerCents: 500, limitPriceCents: 50, marketOpenTimeMs: input.market.openTimeMs,
  });
  input.market.floorStrike = input.history.at(-1)!.floorStrike;
  assert.equal(prepareBtcJumpIntent(input).intent, null);
});
test("ETH, current window, future-known and unfinished observations cannot alter BTC thresholds", () => {
  const input = fixture();
  const baseline = evaluateBtcJump({ ...input });
  const extra = input.history.slice(0, 4).map((f, i) => ({ ...f, floorStrike: 1,
    ticker: i === 0 ? "KXETH15M-POISON" : `KXBTC15M-POISON${i}`,
    openTimeMs: i === 1 ? input.market.openTimeMs : f.openTimeMs,
    finalized: i !== 2, finalizedAtMs: i === 3 ? input.market.observedAtMs + 1 : f.finalizedAtMs }));
  assert.deepEqual(evaluateBtcJump({ ...input, history: [...input.history, ...extra] }), baseline);
});
test("duplicates are idempotent and conflicting same-window facts fail closed", () => {
  const input = fixture();
  const baseline = evaluateBtcJump({ ...input });
  assert.deepEqual(evaluateBtcJump({ ...input, history: [...input.history, input.history[0]!] }), baseline);
  assert.equal(evaluateBtcJump({ ...input, history: [...input.history, { ...input.history[0]!, floorStrike: 1 }] }).reason, "invalid_history");
});
test("missing immediate predecessor cannot be replaced by a nonadjacent market", () => {
  const input = fixture();
  input.history.pop();
  assert.equal(evaluateBtcJump({ ...input }).reason, "missing_adjacent_market");
});
test("gaps do not enter the return sample, and insufficient history blocks", () => {
  const input = fixture();
  input.history.splice(100, 1);
  assert.equal(evaluateBtcJump({ ...input }).historyMoveCount, 248);
  assert.equal(evaluateBtcJump({ ...input, history: input.history.slice(-40) }).reason, "insufficient_history");
});
test("only the trailing 28-day sample is used", () => {
  const input = fixture();
  const baseline = evaluateBtcJump({ ...input });
  const older = input.history.map((f) => ({ ...f, openTimeMs: f.openTimeMs - BTC_B_HISTORY_MS,
    finalizedAtMs: f.finalizedAtMs - BTC_B_HISTORY_MS }));
  assert.deepEqual(evaluateBtcJump({ ...input, history: [...older, ...input.history] }), baseline);
});
test("a degenerate p95=p99 band is empty", () => {
  const input = fixture();
  // Powers of two keep adjacent ratios and boundary arithmetic exact.
  for (const f of input.history) f.floorStrike = 2 ** ((f.openTimeMs - start) / BTC_B_WINDOW_MS);
  const prior = input.history.at(-1)!;
  input.market.floorStrike = prior.floorStrike * 2;
  // All returns = 1, so the degenerate p95=p99 band is empty.
  const result = evaluateBtcJump({ ...input });
  assert.equal(result.p95, 1);
  assert.equal(result.p99, 1);
  assert.equal(result.reason, "at_or_above_p99");
});
test("p95 equality qualifies and p99 equality does not", () => {
  const history: BtcJumpFact[] = [];
  let floorStrike = 1;
  for (let i = 0; i <= 201; i++) {
    if (i > 0) floorStrike *= i <= 192 ? 2 : i <= 199 ? 4 : 8;
    const openTimeMs = start + i * BTC_B_WINDOW_MS;
    history.push({ ticker: `KXBTC15M-B${i}`, openTimeMs, floorStrike, finalized: true,
      finalizedAtMs: openTimeMs + BTC_B_WINDOW_MS });
  }
  const prior = history.at(-1)!;
  const market = { ticker: "KXBTC15M-BOUNDARY", openTimeMs: prior.openTimeMs + BTC_B_WINDOW_MS,
    observedAtMs: prior.openTimeMs + BTC_B_WINDOW_MS + 1000, floorStrike: prior.floorStrike * 2 };
  const p95 = evaluateBtcJump({ market, history });
  assert.equal(p95.p95, 1);
  assert.equal(p95.p99, 3);
  assert.equal(p95.reason, "signal");
  market.floorStrike = prior.floorStrike * 4;
  assert.equal(evaluateBtcJump({ market, history }).reason, "at_or_above_p99");
});
test("invalid market identity and closed entry windows cannot produce a signal", () => {
  const input = fixture();
  for (const market of [{ ...input.market, ticker: "KXETH15M-CURRENT" },
    { ...input.market, floorStrike: NaN }, { ...input.market, openTimeMs: input.market.openTimeMs + 1 },
    { ...input.market, observedAtMs: input.market.openTimeMs + BTC_B_WINDOW_MS }]) {
    assert.equal(evaluateBtcJump({ ...input, market }).reason, "invalid_market");
  }
});
