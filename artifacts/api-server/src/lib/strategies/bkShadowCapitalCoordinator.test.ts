import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateBkShadowFreeCapital,
  shadowAcquireBkCapitalReservation,
  shadowMarkBkAcceptedPendingRefresh,
  shadowMarkBkSubmissionUnknown,
  shadowRefreshAcceptedBkReservation,
  shadowReleaseBkCapitalReservation,
  type BkInflightCapitalReservation,
  type BkInflightCapitalState,
  type BkShadowCapitalStore,
  type BkShadowLockedStore,
} from "./bkShadowCapitalCoordinator.js";

class MemoryStore implements BkShadowCapitalStore {
  private readonly rows = new Map<string, BkInflightCapitalReservation>();
  private readonly tails = new Map<number, Promise<void>>();

  async ensureSchema(): Promise<void> {}

  async withExchangeAdmissionLock<T>(
    exchangeIndex: number,
    fn: (locked: BkShadowLockedStore) => Promise<T>,
  ): Promise<T> {
    const prior = this.tails.get(exchangeIndex) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.tails.set(exchangeIndex, prior.then(() => current));
    await prior;
    try {
      return await fn({
        sumActiveRiskCents: async (target) => [...this.rows.values()]
          .filter((row) => row.exchangeIndex === target
            && ["inflight", "accepted_pending_refresh", "submission_unknown"].includes(row.state))
          .reduce((sum, row) => sum + row.requestedRiskCents, 0),
        insertInflight: async (row) => {
          if (this.rows.has(row.id) || [...this.rows.values()].some((x) => x.clientOrderId === row.clientOrderId)) return false;
          this.rows.set(row.id, { ...row });
          return true;
        },
      });
    } finally {
      release();
      if (this.tails.get(exchangeIndex) === current) this.tails.delete(exchangeIndex);
    }
  }

  async transitionState(input: {
    id: string;
    from: BkInflightCapitalState | BkInflightCapitalState[];
    to: BkInflightCapitalState;
    updatedAtMs: number;
    exchangeOrderId?: string | null;
    lastRecoveryReason?: string | null;
  }): Promise<boolean> {
    const row = this.rows.get(input.id);
    if (!row) return false;
    const allowed = Array.isArray(input.from) ? input.from : [input.from];
    if (!allowed.includes(row.state)) return false;
    this.rows.set(input.id, {
      ...row,
      state: input.to,
      updatedAtMs: input.updatedAtMs,
      exchangeOrderId: input.exchangeOrderId ?? row.exchangeOrderId,
      lastRecoveryReason: input.lastRecoveryReason ?? null,
    });
    return true;
  }

  async getById(id: string): Promise<BkInflightCapitalReservation | null> {
    const row = this.rows.get(id);
    return row ? { ...row } : null;
  }

  async activeRisk(exchangeIndex: number): Promise<number> {
    return this.withExchangeAdmissionLock(exchangeIndex, (locked) => locked.sumActiveRiskCents(exchangeIndex));
  }
}

function admission(id: string, overrides: Partial<Parameters<typeof shadowAcquireBkCapitalReservation>[0]["admission"]> = {}) {
  return {
    id,
    service: "B" as const,
    strategy: "jump",
    ticker: `KXETH15M-${id}`,
    clientOrderId: `client:${id}`,
    exchangeIndex: 2,
    requestedRiskCents: 207,
    nowMs: 1000,
    ...overrides,
  };
}

test("shadow formula subtracts only same-shard in-flight risk", () => {
  assert.equal(calculateBkShadowFreeCapital({
    availableBalanceCents: 500,
    inflightReservedCents: 207,
  }), 293);
});

test("approved policy has no A reserve, fixed safety reserve, or persistent unresolved-order deduction", async () => {
  const store = new MemoryStore();
  const result = await shadowAcquireBkCapitalReservation({
    admission: admission("POLICY", { requestedRiskCents: 207 }),
    store,
    readFreshBalance: async () => ({ availableBalanceCents: 207, observedAtMs: 999, stale: false }),
  });
  assert.equal(result.event.decision, "shadow_allow");
  assert.equal(result.event.freeCapitalCents, 207);
  assert.equal(result.event.inflightReservedCents, 0);
  assert.equal(await store.activeRisk(2), 207);
});

test("one cent below fee-inclusive requested risk blocks", async () => {
  const store = new MemoryStore();
  const result = await shadowAcquireBkCapitalReservation({
    admission: admission("SHORT", { requestedRiskCents: 207 }),
    store,
    readFreshBalance: async () => ({ availableBalanceCents: 206, observedAtMs: 999, stale: false }),
  });
  assert.equal(result.event.decision, "shadow_block");
  assert.equal(result.event.freeCapitalCents, 206);
  assert.equal(result.reservation, null);
});

test("same-shard concurrent decisions cannot spend the same just-read balance", async () => {
  const store = new MemoryStore();
  let reads = 0;
  const readFreshBalance = async () => {
    reads += 1;
    await new Promise((resolve) => setTimeout(resolve, 2));
    return { availableBalanceCents: 300, observedAtMs: 1000 + reads, stale: false as const };
  };
  const [first, second] = await Promise.all([
    shadowAcquireBkCapitalReservation({
      admission: admission("RACE-B", { service: "B", requestedRiskCents: 207 }),
      store,
      readFreshBalance,
    }),
    shadowAcquireBkCapitalReservation({
      admission: admission("RACE-I", {
        service: "I", strategy: "ash_v2_i", requestedRiskCents: 129,
        clientOrderId: "client:RACE-I",
      }),
      store,
      readFreshBalance,
    }),
  ]);
  const decisions = [first.event.decision, second.event.decision].sort();
  assert.deepEqual(decisions, ["shadow_allow", "shadow_block"]);
  assert.equal(await store.activeRisk(2), first.reservation?.requestedRiskCents ?? second.reservation?.requestedRiskCents);
});

test("different exchange shards do not reserve against one another", async () => {
  const store = new MemoryStore();
  const [left, right] = await Promise.all([
    shadowAcquireBkCapitalReservation({
      admission: admission("S0", { exchangeIndex: 0, requestedRiskCents: 207 }),
      store,
      readFreshBalance: async () => ({ availableBalanceCents: 207, observedAtMs: 1000, stale: false }),
    }),
    shadowAcquireBkCapitalReservation({
      admission: admission("S2", { exchangeIndex: 2, requestedRiskCents: 207, clientOrderId: "client:S2" }),
      store,
      readFreshBalance: async () => ({ availableBalanceCents: 207, observedAtMs: 1000, stale: false }),
    }),
  ]);
  assert.equal(left.event.decision, "shadow_allow");
  assert.equal(right.event.decision, "shadow_allow");
  assert.equal(await store.activeRisk(0), 207);
  assert.equal(await store.activeRisk(2), 207);
});

test("explicit rejection/zero-order proof releases reservation", async () => {
  const store = new MemoryStore();
  const acquired = await shadowAcquireBkCapitalReservation({
    admission: admission("REJECT"),
    store,
    readFreshBalance: async () => ({ availableBalanceCents: 500, observedAtMs: 1000, stale: false }),
  });
  assert.ok(acquired.reservation);
  assert.equal(await shadowReleaseBkCapitalReservation({
    store,
    reservationId: acquired.reservation!.id,
    reason: "authoritative_rejection",
    nowMs: 1100,
  }), true);
  assert.equal(await store.activeRisk(2), 0);
});

test("ambiguous submission remains fail-closed and continues to reserve", async () => {
  const store = new MemoryStore();
  const acquired = await shadowAcquireBkCapitalReservation({
    admission: admission("UNKNOWN"),
    store,
    readFreshBalance: async () => ({ availableBalanceCents: 500, observedAtMs: 1000, stale: false }),
  });
  assert.ok(acquired.reservation);
  assert.equal(await shadowMarkBkSubmissionUnknown({
    store,
    reservationId: acquired.reservation!.id,
    reason: "post_response_lost",
    nowMs: 1100,
  }), true);
  assert.equal((await store.getById(acquired.reservation!.id))?.state, "submission_unknown");
  assert.equal(await store.activeRisk(2), 207);
});

test("accepted order retains anti-race reserve until a fresh same-shard balance refresh succeeds", async () => {
  const store = new MemoryStore();
  const acquired = await shadowAcquireBkCapitalReservation({
    admission: admission("ACCEPT"),
    store,
    readFreshBalance: async () => ({ availableBalanceCents: 500, observedAtMs: 1000, stale: false }),
  });
  assert.ok(acquired.reservation);
  assert.equal(await shadowMarkBkAcceptedPendingRefresh({
    store,
    reservationId: acquired.reservation!.id,
    exchangeOrderId: "order:accepted",
    nowMs: 1050,
  }), true);
  assert.equal(await store.activeRisk(2), 207);

  let failed = false;
  assert.equal(await shadowRefreshAcceptedBkReservation({
    store,
    reservationId: acquired.reservation!.id,
    readFreshBalance: async () => { failed = true; throw new Error("temporary balance read failure"); },
    nowMs: 1060,
  }), false);
  assert.equal(failed, true);
  assert.equal(await store.activeRisk(2), 207);

  assert.equal(await shadowRefreshAcceptedBkReservation({
    store,
    reservationId: acquired.reservation!.id,
    readFreshBalance: async (exchangeIndex) => {
      assert.equal(exchangeIndex, 2);
      return { availableBalanceCents: 293, observedAtMs: 1070, stale: false };
    },
    nowMs: 1080,
  }), true);
  assert.equal(await store.activeRisk(2), 0);
});

test("all service letters B-K are valid shadow participants without changing strategy semantics", async () => {
  const services = ["B","C","D","E","F","G","H","I","J","K"] as const;
  for (const service of services) {
    const store = new MemoryStore();
    const result = await shadowAcquireBkCapitalReservation({
      admission: admission(`SERVICE-${service}`, {
        service,
        strategy: `strategy_${service}`,
        clientOrderId: `client:SERVICE-${service}`,
        requestedRiskCents: 1,
      }),
      store,
      readFreshBalance: async () => ({ availableBalanceCents: 1, observedAtMs: 1000, stale: false }),
    });
    assert.equal(result.event.decision, "shadow_allow", service);
  }
});

test("fresh balance failure is unavailable/fail-closed and creates no reservation", async () => {
  const store = new MemoryStore();
  const result = await shadowAcquireBkCapitalReservation({
    admission: admission("BALFAIL"),
    store,
    readFreshBalance: async () => { throw new Error("Kalshi unavailable"); },
  });
  assert.equal(result.event.decision, "shadow_unavailable");
  assert.equal(result.event.reason, "fresh_balance_unavailable");
  assert.equal(await store.activeRisk(2), 0);
});
