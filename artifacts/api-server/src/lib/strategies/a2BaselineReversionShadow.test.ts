import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateA2BaselineReversionShadow,
  a2ShadowClaimId,
} from "./a2BaselineReversionShadow.js";
import type {
  A2ShadowClaimInput,
  A2ShadowClaimOutcome,
  A2ShadowEvidenceRecord,
  A2ShadowStore,
} from "./a2BaselineReversionShadowStore.js";

class MemoryA2Store implements A2ShadowStore {
  evidence = new Map<string, A2ShadowEvidenceRecord>();
  claims = new Map<string, { input: A2ShadowClaimInput; state: "shadow_open" | "shadow_settled" }>();
  private tail: Promise<void> = Promise.resolve();

  async recordEvidence(input: A2ShadowEvidenceRecord): Promise<boolean> {
    if (this.evidence.has(input.id)) return false;
    this.evidence.set(input.id, { ...input });
    return true;
  }

  async countOpen(): Promise<number | null> {
    return [...this.claims.values()].filter((x) => x.state === "shadow_open").length;
  }

  async claimOpen(input: A2ShadowClaimInput): Promise<A2ShadowClaimOutcome> {
    const prior = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    try {
      if (this.claims.has(input.id)
        || [...this.claims.values()].some((x) =>
          x.input.sourceOpenTimeMs === input.sourceOpenTimeMs
          && x.input.destinationTicker === input.destinationTicker)) return "duplicate";
      if ([...this.claims.values()].some((x) => x.state === "shadow_open")) return "active_exposure_limit";
      this.claims.set(input.id, { input: { ...input }, state: "shadow_open" });
      return "opened";
    } finally {
      release();
    }
  }

  async settle(input: { id: string; settlementResult: "yes" | "no"; settledAtMs: number }): Promise<boolean> {
    const row = this.claims.get(input.id);
    if (!row || row.state !== "shadow_open") return false;
    this.claims.set(input.id, { ...row, state: "shadow_settled" });
    return true;
  }
}

const source = (openTimeMs = 900_000) => ({
  openTimeMs,
  closeTimeMs: openTimeMs + 900_000,
  open: 100,
  high: 101,
  low: 98.8,
  close: 99,
  finalized: true,
});

const destination = (openTimeMs = 1_800_000) => ({
  ticker: `KXBTC15M-A2-${openTimeMs}`,
  openTimeMs,
  closeTimeMs: openTimeMs + 900_000,
  yesAskCents: 45,
  yesSettlesAboveStrike: true,
});

test("disabled A2 shadow performs no store writes", async () => {
  const store = new MemoryA2Store();
  const result = await evaluateA2BaselineReversionShadow({
    config: { enabled: false },
    source: source(),
    destination: destination(),
    observedAtMs: 2_000_000,
    store,
  });
  assert.equal(result.outcome, "disabled");
  assert.equal(store.evidence.size, 0);
  assert.equal(store.claims.size, 0);
});

test("qualified A2 shadow records evidence and opens exactly one claim", async () => {
  const store = new MemoryA2Store();
  const result = await evaluateA2BaselineReversionShadow({
    config: { enabled: true },
    source: source(),
    destination: destination(),
    observedAtMs: 2_000_000,
    store,
  });
  assert.equal(result.outcome, "shadow_opened");
  assert.equal(result.signal, true);
  assert.equal(store.evidence.size, 1);
  assert.equal(store.claims.size, 1);
  const claim = [...store.claims.values()][0]!;
  assert.equal(claim.input.stakeCents, 500);
  assert.equal(claim.input.maxEntryPriceCents, 45);
  assert.equal(claim.input.side, "yes");
});

test("nonqualifying A2 shadow records evidence but creates no claim", async () => {
  const store = new MemoryA2Store();
  const result = await evaluateA2BaselineReversionShadow({
    config: { enabled: true },
    source: { ...source(), close: 99.9 },
    destination: destination(),
    observedAtMs: 2_000_000,
    store,
  });
  assert.equal(result.outcome, "no_signal");
  assert.equal(store.evidence.size, 1);
  assert.equal(store.claims.size, 0);
});

test("same source and destination are permanently idempotent", async () => {
  const store = new MemoryA2Store();
  const args = {
    config: { enabled: true },
    source: source(),
    destination: destination(),
    store,
  };
  const first = await evaluateA2BaselineReversionShadow({ ...args, observedAtMs: 2_000_000 });
  const second = await evaluateA2BaselineReversionShadow({ ...args, observedAtMs: 2_000_001 });
  assert.equal(first.outcome, "shadow_opened");
  assert.equal(second.outcome, "active_exposure_limit");
  assert.equal(store.claims.size, 1);
});

test("concurrent different qualifying signals cannot open more than one A2 exposure", async () => {
  const store = new MemoryA2Store();
  const firstSource = source(900_000);
  const secondSource = source(1_800_000);
  const [first, second] = await Promise.all([
    evaluateA2BaselineReversionShadow({
      config: { enabled: true },
      source: firstSource,
      destination: destination(firstSource.closeTimeMs),
      observedAtMs: 3_000_000,
      store,
    }),
    evaluateA2BaselineReversionShadow({
      config: { enabled: true },
      source: secondSource,
      destination: destination(secondSource.closeTimeMs),
      observedAtMs: 3_000_001,
      store,
    }),
  ]);
  const outcomes = [first.outcome, second.outcome].sort();
  assert.deepEqual(outcomes, ["active_exposure_limit", "shadow_opened"]);
  assert.equal([...store.claims.values()].filter((x) => x.state === "shadow_open").length, 1);
});

test("settlement releases the one-exposure shadow slot for a later signal", async () => {
  const store = new MemoryA2Store();
  const s1 = source(900_000);
  const d1 = destination(s1.closeTimeMs);
  const first = await evaluateA2BaselineReversionShadow({
    config: { enabled: true }, source: s1, destination: d1, observedAtMs: 3_000_000, store,
  });
  assert.equal(first.outcome, "shadow_opened");
  assert.equal(await store.settle({
    id: a2ShadowClaimId(s1.openTimeMs, d1.ticker),
    settlementResult: "yes",
    settledAtMs: d1.closeTimeMs + 1,
  }), true);

  const s2 = source(1_800_000);
  const d2 = destination(s2.closeTimeMs);
  const second = await evaluateA2BaselineReversionShadow({
    config: { enabled: true }, source: s2, destination: d2, observedAtMs: 4_000_000, store,
  });
  assert.equal(second.outcome, "shadow_opened");
});
