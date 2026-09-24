import assert from "node:assert/strict";
import test from "node:test";
import {
  A2_DROP_THRESHOLD,
  A2_FIXED_STAKE_CENTS,
  A2_MAX_ENTRY_PRICE_CENTS,
  A2_BASELINE_REVERSION_STRATEGY_ID,
  evaluateA2BaselineReversion,
  loadA2BaselineReversionConfig,
} from "./a2BaselineReversion.js";

const source = (close: number) => ({
  openTimeMs: 0,
  closeTimeMs: 900_000,
  open: 100,
  high: 101,
  low: Math.min(99, close),
  close,
  finalized: true,
});

const destination = (overrides: Record<string, unknown> = {}) => ({
  ticker: "KXBTC15M-TEST-A2",
  openTimeMs: 900_000,
  closeTimeMs: 1_800_000,
  yesAskCents: 45,
  yesSettlesAboveStrike: true,
  ...overrides,
});

test("A2 is disabled by default", () => {
  assert.deepEqual(loadA2BaselineReversionConfig({}), { enabled: false });
});

test("exact 0.8% finalized BTC drop qualifies at 45 cents", () => {
  const decision = evaluateA2BaselineReversion({
    config: { enabled: true },
    source: source(99.2),
    destination: destination(),
    activeA2ExposureCount: 0,
  });
  assert.equal(decision.signal, true);
  if (!decision.signal) return;
  assert.equal(decision.strategyId, A2_BASELINE_REVERSION_STRATEGY_ID);
  assert.equal(decision.side, "yes");
  assert.equal(decision.stakeCents, A2_FIXED_STAKE_CENTS);
  assert.equal(decision.maxEntryPriceCents, A2_MAX_ENTRY_PRICE_CENTS);
  assert.ok(Math.abs(decision.sourceDropFraction - A2_DROP_THRESHOLD) < 1e-12);
});

test("drop below 0.8% does not qualify", () => {
  const decision = evaluateA2BaselineReversion({
    config: { enabled: true },
    source: source(99.21),
    destination: destination(),
    activeA2ExposureCount: 0,
  });
  assert.deepEqual(decision.signal, false);
  if (decision.signal) return;
  assert.equal(decision.reason, "drop_below_threshold");
});

test("source candle must be finalized", () => {
  const decision = evaluateA2BaselineReversion({
    config: { enabled: true },
    source: { ...source(99), finalized: false },
    destination: destination(),
    activeA2ExposureCount: 0,
  });
  assert.deepEqual(decision, { signal: false, reason: "source_not_final" });
});

test("destination must be the immediately following BTC 15-minute window", () => {
  const decision = evaluateA2BaselineReversion({
    config: { enabled: true },
    source: source(99),
    destination: destination({ openTimeMs: 1_800_000, closeTimeMs: 2_700_000 }),
    activeA2ExposureCount: 0,
  });
  assert.equal(decision.signal, false);
  if (decision.signal) return;
  assert.equal(decision.reason, "not_immediate_following_window");
});

test("YES contract semantics must be verified as settles above strike", () => {
  const decision = evaluateA2BaselineReversion({
    config: { enabled: true },
    source: source(99),
    destination: destination({ yesSettlesAboveStrike: false }),
    activeA2ExposureCount: 0,
  });
  assert.equal(decision.signal, false);
  if (decision.signal) return;
  assert.equal(decision.reason, "yes_semantics_unverified");
});

test("45 cent entry cap is inclusive and 46 cents is blocked", () => {
  const allowed = evaluateA2BaselineReversion({
    config: { enabled: true },
    source: source(99),
    destination: destination({ yesAskCents: 45 }),
    activeA2ExposureCount: 0,
  });
  assert.equal(allowed.signal, true);

  const blocked = evaluateA2BaselineReversion({
    config: { enabled: true },
    source: source(99),
    destination: destination({ yesAskCents: 46 }),
    activeA2ExposureCount: 0,
  });
  assert.equal(blocked.signal, false);
  if (blocked.signal) return;
  assert.equal(blocked.reason, "entry_price_above_cap");
});

test("one active A2 exposure maximum blocks another signal", () => {
  const decision = evaluateA2BaselineReversion({
    config: { enabled: true },
    source: source(99),
    destination: destination(),
    activeA2ExposureCount: 1,
  });
  assert.equal(decision.signal, false);
  if (decision.signal) return;
  assert.equal(decision.reason, "active_exposure_limit");
});
