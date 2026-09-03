import assert from "node:assert/strict";
import test from "node:test";
import {
  _setDogeNoMartingaleDependenciesForTesting, DOGE_PENDING_RESERVATION_EXPIRY_MS, DOGE_PRINCIPALS_CENTS,
  DOGE_RECOVERY_SIZING, dogeFeeAwareRecoveryContracts, dogeNoOrderPayload, dogePrincipalForStep,
  dogeTakerFeeCents, evaluateDogeNoMartingale, isDogeOpeningWindow, isDogeTicker,
  reconcileDogeMartingaleSettlements, resetDogeMartingaleBeforeWindow,
} from "./dogeNoMartingale.js";

test("DOGE is isolated to KXDOGE15M and has an exact 20–25 second entry window", () => {
  const opened = Date.parse("2026-08-22T12:00:00.000Z");
  assert.equal(isDogeTicker("KXDOGE15M-26AUG221200-00"), true);
  assert.equal(isDogeTicker("KXBTC15M-26AUG221200-00"), false);
  assert.equal(isDogeOpeningWindow("2026-08-22T12:00:00.000Z", opened + 19_999), false);
  assert.equal(isDogeOpeningWindow("2026-08-22T12:00:00.000Z", opened + 20_000), true);
  assert.equal(isDogeOpeningWindow("2026-08-22T12:00:00.000Z", opened + 24_999), true);
  assert.equal(isDogeOpeningWindow("2026-08-22T12:00:00.000Z", opened + 25_000), false);
});

test("DOGE NO uses the same ask/complement Kalshi wire convention as existing strategies", () => {
  const payload = dogeNoOrderPayload("KXDOGE15M-test", "doge-1", 2, 71);
  assert.equal(payload.side, "ask");
  assert.equal(payload.price, "0.2900");
  assert.equal(payload.count, "2.00");
});

test("DOGE uses the exact five-attempt fixed principal ladder and never exposes a sixth step", () => {
  assert.deepEqual(DOGE_PRINCIPALS_CENTS, [1042, 2084, 4168, 8336, 16672]);
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(dogePrincipalForStep), [1042, 2084, 4168, 8336, 16672, 16672]);
});

test("DOGE reserves fee safely but does not turn it into a sixth dynamic ladder size", () => {
  assert.equal(DOGE_RECOVERY_SIZING, "fixed_five_step_ladder");
  assert.equal(dogeTakerFeeCents(50, 1), 2, "a fractional-cent fee rounds up");
  const contracts = dogeFeeAwareRecoveryContracts(50, 20_000, 10_000);
  assert.equal(contracts, 622);
  assert.ok(contracts * 50 - dogeTakerFeeCents(50, contracts) >= 30_000);
  assert.ok((contracts - 1) * 50 - dogeTakerFeeCents(50, contracts - 1) < 30_000);
});

test("fee calculation remains available for actual-filled exposure accounting", () => {
  const firstLoss = 100 + dogeTakerFeeCents(50, 2);
  const secondContracts = dogeFeeAwareRecoveryContracts(50, firstLoss, 100);
  const secondLoss = secondContracts * 50 + dogeTakerFeeCents(50, secondContracts);
  const thirdContracts = dogeFeeAwareRecoveryContracts(50, firstLoss + secondLoss, 100);
  assert.ok(thirdContracts > secondContracts);
  assert.ok(thirdContracts * 50 - dogeTakerFeeCents(50, thirdContracts) >= firstLoss + secondLoss + 100);
});

test("T-minus-five reset is durable and only fires in the pre-window slot", async () => {
  const boundary = Date.parse("2026-08-22T12:15:00.000Z");
  const resets: number[] = [];
  _setDogeNoMartingaleDependenciesForTesting({
    now: () => boundary - 5_000,
    store: { resetDogeMartingaleSequence: async (at: number) => { resets.push(at); return true; } },
  } as any);
  try {
    await resetDogeMartingaleBeforeWindow(boundary - 5_001);
    await resetDogeMartingaleBeforeWindow(boundary - 5_000);
    await resetDogeMartingaleBeforeWindow(boundary);
    assert.deepEqual(resets, [boundary - 5_000]);
  } finally { _setDogeNoMartingaleDependenciesForTesting(null); }
});

test("DOGE skips insufficient NO liquidity without reserving or advancing a ladder step", async () => {
  const now = Date.parse("2026-08-22T12:00:21.000Z");
  let reservations = 0;
  const previous = process.env["DOGE_NO_MARTINGALE_ENABLED"];
  process.env["DOGE_NO_MARTINGALE_ENABLED"] = "true";
  _setDogeNoMartingaleDependenciesForTesting({
    now: () => now, isDogeOrderSubmissionPermitted: () => true, allowNewInvestment: async () => ({ allowed: true }),
    captureOrderbook: async () => ({ lowestLevelCents: 50, depthAtOrBetterContracts: 19, error: null }),
    store: {
      listUnsettledDogeMartingaleOrders: async () => [],
      getDogeMartingaleState: async () => ({ easternDate: "2026-08-22", martingaleStep: 0, spentCents: 0, recoveryLossCents: 0 }),
      reserveDogeMartingaleEntry: async () => { reservations++; return true; },
    },
  } as any);
  try {
    await evaluateDogeNoMartingale({ ticker: "KXDOGE15M-26AUG221200-00", openTime: new Date(now - 21_000).toISOString(), closeTime: null, status: "open" });
    assert.equal(reservations, 0, "the $10.42 step needs 20 whole 50¢ contracts, so 19 is a full-fill-or-skip rejection");
  } finally {
    _setDogeNoMartingaleDependenciesForTesting(null);
    if (previous == null) delete process.env["DOGE_NO_MARTINGALE_ENABLED"]; else process.env["DOGE_NO_MARTINGALE_ENABLED"] = previous;
  }
});

test("DOGE rechecks its permission immediately before POST and releases a known-unsubmitted reservation", async () => {
  const now = Date.parse("2026-08-22T12:00:21.000Z");
  const previous = process.env["DOGE_NO_MARTINGALE_ENABLED"];
  let permissionChecks = 0;
  let posts = 0;
  let finalOutcome: string | null = null;
  process.env["DOGE_NO_MARTINGALE_ENABLED"] = "true";
  _setDogeNoMartingaleDependenciesForTesting({
    now: () => now,
    isDogeOrderSubmissionPermitted: () => ++permissionChecks === 1,
    allowNewInvestment: async () => ({ allowed: true }),
    captureOrderbook: async () => ({ lowestLevelCents: 50, depthAtOrBetterContracts: 20, error: null }),
    authFetch: async () => { posts++; return {}; },
    store: {
      listUnsettledDogeMartingaleOrders: async () => [],
      getDogeMartingaleState: async () => ({ easternDate: "2026-08-22", martingaleStep: 0, spentCents: 0, recoveryLossCents: 0 }),
      reserveDogeMartingaleEntry: async () => true,
      markDogeMartingaleOrderPostStarted: async () => true,
      updateDogeMartingaleOrder: async (update: any) => {
        finalOutcome = update.outcome;
        assert.equal(update.filledContracts, 0);
        assert.equal(update.filledFeeCents, 0);
        return true;
      },
    },
  } as any);
  try {
    await evaluateDogeNoMartingale({
      ticker: "KXDOGE15M-26AUG221200-00",
      openTime: new Date(now - 21_000).toISOString(),
      closeTime: null,
      status: "open",
    });
    assert.equal(permissionChecks, 0, "retired DOGE is rejected before legacy permission hooks");
    assert.equal(posts, 0, "a closed final gate must prevent the exchange request");
    assert.equal(finalOutcome, null, "retired DOGE never creates a reservation to release");
  } finally {
    _setDogeNoMartingaleDependenciesForTesting(null);
    if (previous == null) delete process.env["DOGE_NO_MARTINGALE_ENABLED"];
    else process.env["DOGE_NO_MARTINGALE_ENABLED"] = previous;
  }
});

test("retired DOGE strategy cannot POST even when its legacy environment flag is enabled", async () => {
  const now = Date.parse("2026-08-22T12:00:21.000Z");
  const previous = process.env["DOGE_NO_MARTINGALE_ENABLED"];
  let posts = 0;
  let storeTouched = false;
  process.env["DOGE_NO_MARTINGALE_ENABLED"] = "true";
  _setDogeNoMartingaleDependenciesForTesting({
    now: () => now,
    // Do not override isDogeOrderSubmissionPermitted: this verifies the
    // production final boundary, not a test-only simulated permission.
    authFetch: async () => { posts++; return {}; },
    store: {
      listUnsettledDogeMartingaleOrders: async () => { storeTouched = true; return []; },
    },
  } as any);
  try {
    await evaluateDogeNoMartingale({
      ticker: "KXDOGE15M-26AUG221200-00",
      openTime: new Date(now - 21_000).toISOString(),
      closeTime: null,
      status: "open",
    });
    assert.equal(posts, 0, "retired DOGE path must never POST an exchange order");
    assert.equal(storeTouched, false, "final permission gate must reject before state changes");
  } finally {
    _setDogeNoMartingaleDependenciesForTesting(null);
    if (previous == null) delete process.env["DOGE_NO_MARTINGALE_ENABLED"];
    else process.env["DOGE_NO_MARTINGALE_ENABLED"] = previous;
  }
});

test("a recovered DOGE loss carries Kalshi's reported fee when it differs from the quote estimate", async () => {
  const row: any = {
    id: "doge-entry:recovered-loss", ticker: "KXDOGE15M-recovered", easternDate: "2026-08-22",
    martingaleStep: 0, clientOrderId: "doge-no-recovered", kalshiOrderId: null, noPriceCents: 50,
    requestedContracts: 2, reservedFeeCents: 4, filledContracts: null, filledFeeCents: null,
    outcome: "unresolved", settlementResult: null, createdAtMs: 0, submissionVersion: 1,
  };
  let carriedLossCents = 0;
  _setDogeNoMartingaleDependenciesForTesting({
    authFetch: async (_method: string, path: string) => path.startsWith("/portfolio/orders?")
      ? { orders: [{ order_id: "kalshi-recovered", client_order_id: row.clientOrderId, ticker: row.ticker }] }
      : { order: {
        order_id: "kalshi-recovered", client_order_id: row.clientOrderId, ticker: row.ticker,
        status: "filled", fill_count_fp: "2.00", fee_cost: "0.07",
      } },
    marketFetch: async () => ({ market: { result: "yes" } }),
    store: {
      listUnsettledDogeMartingaleOrders: async () => row.settlementResult == null ? [row] : [],
      updateDogeMartingaleOrder: async (update: any) => { Object.assign(row, update); return true; },
      settleDogeMartingaleOrder: async (_id: string, result: "yes" | "no") => {
        row.settlementResult = result;
        carriedLossCents = row.filledContracts * row.noPriceCents + row.filledFeeCents;
        return true;
      },
    },
  } as any);
  try {
    await reconcileDogeMartingaleSettlements();
    assert.equal(dogeTakerFeeCents(50, 2), 4, "the quote-time estimate is intentionally different");
    assert.equal(row.filledFeeCents, 7, "recovered fill persists Kalshi's reported fee");
    assert.equal(carriedLossCents, 107, "loss state carries actual filled principal and fee");
    const recoveryContracts = dogeFeeAwareRecoveryContracts(50, carriedLossCents);
    assert.ok(recoveryContracts * 50 - dogeTakerFeeCents(50, recoveryContracts) >= carriedLossCents + 1042);
  } finally {
    _setDogeNoMartingaleDependenciesForTesting(null);
  }
});

test("retired DOGE never creates an unresolved entry, even when a legacy POST seam would fail", async () => {
  const now = Date.parse("2026-08-22T12:00:21.000Z");
  const rows: any[] = [];
  let reservations = 0;
  const store: any = {
    getDogeMartingaleState: async () => ({ easternDate: "2026-08-22", martingaleStep: 0, spentCents: 0 }),
    reserveDogeMartingaleEntry: async (params: any) => {
      reservations++;
      rows.push({ ...params, kalshiOrderId: null, filledContracts: null, outcome: "pending", settlementResult: null, createdAtMs: now, submissionVersion: 1 });
      return true;
    },
    markDogeMartingaleOrderPostStarted: async (id: string) => {
      const row = rows.find((candidate) => candidate.id === id);
      if (!row || row.outcome !== "pending") return false;
      row.outcome = "post_started";
      return true;
    },
    expireDogeMartingaleReservation: async () => false,
    updateDogeMartingaleOrder: async (update: any) => {
      const row = rows.find((candidate) => candidate.id === update.id);
      Object.assign(row, update);
      return true;
    },
    listUnsettledDogeMartingaleOrders: async () => rows.filter((row) => !["expired", "error", "zero_fill"].includes(row.outcome)),
    settleDogeMartingaleOrder: async () => true,
  };
  const previous = process.env["DOGE_NO_MARTINGALE_ENABLED"];
  process.env["DOGE_NO_MARTINGALE_ENABLED"] = "true";
  _setDogeNoMartingaleDependenciesForTesting({
    now: () => now, store, isDogeOrderSubmissionPermitted: () => true, allowNewInvestment: async () => ({ allowed: true }),
    captureOrderbook: async () => ({ lowestLevelCents: 50, depthAtOrBetterContracts: 20, error: null }),
    authFetch: async (method: string) => {
      if (method === "POST") throw new Error("socket hang up");
      return { orders: [] };
    },
    marketFetch: async () => null,
  } as any);
  try {
    await evaluateDogeNoMartingale({ ticker: "KXDOGE15M-26AUG221200-00", openTime: new Date(now - 21_000).toISOString(), closeTime: null, status: "open" });
    assert.equal(rows.length, 0, "retired DOGE cannot reserve an order");
    await evaluateDogeNoMartingale({ ticker: "KXDOGE15M-26AUG221215-00", openTime: new Date(now - 21_000).toISOString(), closeTime: null, status: "open" });
    assert.equal(reservations, 0, "retired DOGE cannot reserve a second order");
  } finally {
    _setDogeNoMartingaleDependenciesForTesting(null);
    if (previous == null) delete process.env["DOGE_NO_MARTINGALE_ENABLED"];
    else process.env["DOGE_NO_MARTINGALE_ENABLED"] = previous;
  }
});


test("pending reservation beyond its confirmation window expires and releases its unused budget", async () => {
  const now = Date.parse("2026-08-22T12:02:00.000Z");
  const row: any = {
    id: "doge-entry:stale", ticker: "KXDOGE15M-26AUG221200-00", easternDate: "2026-08-22",
    martingaleStep: 0, clientOrderId: "stale-client", kalshiOrderId: null, noPriceCents: 50,
    requestedContracts: 2, filledContracts: null, outcome: "pending", settlementResult: null,
    createdAtMs: now - DOGE_PENDING_RESERVATION_EXPIRY_MS - 1, submissionVersion: 1,
  };
  let releasedCents = 0;
  _setDogeNoMartingaleDependenciesForTesting({
    now: () => now,
    store: {
      listUnsettledDogeMartingaleOrders: async () => [row],
      expireDogeMartingaleReservation: async () => {
        row.outcome = "expired"; row.filledContracts = 0; releasedCents = row.requestedContracts * row.noPriceCents; return true;
      },
    },
  } as any);
  try {
    await reconcileDogeMartingaleSettlements();
    assert.equal(row.outcome, "expired");
    assert.equal(row.filledContracts, 0);
    assert.equal(releasedCents, 100);
  } finally {
    _setDogeNoMartingaleDependenciesForTesting(null);
  }
});

test("legacy pending row is never expired before migration marks it ambiguous", async () => {
  const row: any = {
    id: "doge-entry:legacy", ticker: "KXDOGE15M-26AUG221200-00", outcome: "pending",
    createdAtMs: 0, submissionVersion: 0,
  };
  let expiryCalls = 0;
  let reservations = 0;
  const previous = process.env["DOGE_NO_MARTINGALE_ENABLED"];
  process.env["DOGE_NO_MARTINGALE_ENABLED"] = "true";
  _setDogeNoMartingaleDependenciesForTesting({
    now: () => DOGE_PENDING_RESERVATION_EXPIRY_MS + 1,
    isDogeOrderSubmissionPermitted: () => true,
    allowNewInvestment: async () => ({ allowed: true }),
    captureOrderbook: async () => ({ lowestLevelCents: 50, depthAtOrBetterContracts: 3, error: null }),
    store: {
      listUnsettledDogeMartingaleOrders: async () => [row],
      expireDogeMartingaleReservation: async () => { expiryCalls++; return true; },
      reserveDogeMartingaleEntry: async () => { reservations++; return true; },
    },
  } as any);
  try {
    await reconcileDogeMartingaleSettlements();
    assert.equal(expiryCalls, 0, "unfenced legacy pending reservations remain fail-closed");
    assert.equal(row.outcome, "pending");
    await evaluateDogeNoMartingale({
      ticker: "KXDOGE15M-26AUG221200-00",
      openTime: new Date(DOGE_PENDING_RESERVATION_EXPIRY_MS - 20_000).toISOString(),
      closeTime: null, status: "open",
    });
    assert.equal(reservations, 0, "legacy reservation blocks a new entry until it is recovered");
  } finally {
    _setDogeNoMartingaleDependenciesForTesting(null);
    if (previous == null) delete process.env["DOGE_NO_MARTINGALE_ENABLED"];
    else process.env["DOGE_NO_MARTINGALE_ENABLED"] = previous;
  }
});

test("recovery refuses mismatched exchange identities and keeps the DOGE reservation unresolved", async () => {
  const now = Date.parse("2026-08-22T12:00:21.000Z");
  const row: any = {
    id: "doge-entry:owned", ticker: "KXDOGE15M-26AUG221200-00", easternDate: "2026-08-22",
    martingaleStep: 1, clientOrderId: "doge-no-owned", kalshiOrderId: null, noPriceCents: 50,
    requestedContracts: 2, filledContracts: null, outcome: "unresolved", settlementResult: null,
    createdAtMs: now, submissionVersion: 1,
  };
  let reservations = 0;
  let settlementCalls = 0;
  const previous = process.env["DOGE_NO_MARTINGALE_ENABLED"];
  process.env["DOGE_NO_MARTINGALE_ENABLED"] = "true";
  _setDogeNoMartingaleDependenciesForTesting({
    now: () => now,
    isDogeOrderSubmissionPermitted: () => true,
    allowNewInvestment: async () => ({ allowed: true }),
    captureOrderbook: async () => ({ lowestLevelCents: 50, depthAtOrBetterContracts: 3, error: null }),
    authFetch: async (method: string) => {
      if (method === "GET") {
        return {
          orders: [
            { order_id: "wrong-client", client_order_id: "someone-else", ticker: row.ticker },
            { order_id: "wrong-ticker", client_order_id: row.clientOrderId, ticker: "KXDOGE15M-other" },
          ],
        };
      }
      throw new Error("POST must not be reached while an unresolved reservation exists");
    },
    marketFetch: async () => ({ market: { result: "yes" } }),
    store: {
      listUnsettledDogeMartingaleOrders: async () => row.settlementResult == null && row.outcome !== "zero_fill" ? [row] : [],
      updateDogeMartingaleOrder: async () => { throw new Error("mismatched exchange order must not be attached"); },
      settleDogeMartingaleOrder: async () => { settlementCalls++; return true; },
      getDogeMartingaleState: async () => ({ easternDate: "2026-08-22", martingaleStep: 1, spentCents: 100 }),
      reserveDogeMartingaleEntry: async () => { reservations++; return true; },
    },
  } as any);
  try {
    await reconcileDogeMartingaleSettlements();
    assert.equal(row.outcome, "unresolved");
    assert.equal(row.kalshiOrderId, null);
    assert.equal(settlementCalls, 0);
    await evaluateDogeNoMartingale({
      ticker: "KXDOGE15M-26AUG221215-00", openTime: new Date(now - 21_000).toISOString(),
      closeTime: null, status: "open",
    });
    assert.equal(reservations, 0, "an identity mismatch must block a new DOGE reservation");
  } finally {
    _setDogeNoMartingaleDependenciesForTesting(null);
    if (previous == null) delete process.env["DOGE_NO_MARTINGALE_ENABLED"];
    else process.env["DOGE_NO_MARTINGALE_ENABLED"] = previous;
  }
});

test("verified zero-fill recovery releases the entire DOGE reservation without settlement or martingale advance", async () => {
  const row: any = {
    id: "doge-entry:zero", ticker: "KXDOGE15M-26AUG221200-00", easternDate: "2026-08-22",
    martingaleStep: 2, clientOrderId: "doge-no-zero", kalshiOrderId: null, noPriceCents: 25,
    requestedContracts: 4, filledContracts: null, outcome: "unresolved", settlementResult: null,
    createdAtMs: 0, submissionVersion: 1,
  };
  let spentCents = 100;
  let martingaleStep = 2;
  let settlementCalls = 0;
  _setDogeNoMartingaleDependenciesForTesting({
    authFetch: async (_method: string, path: string) => path.startsWith("/portfolio/orders?")
      ? { orders: [{ order_id: "kalshi-zero", client_order_id: row.clientOrderId, ticker: row.ticker }] }
      : { order: { order_id: "kalshi-zero", client_order_id: row.clientOrderId, ticker: row.ticker, status: "canceled", fill_count_fp: "0.00" } },
    marketFetch: async () => { throw new Error("a verified zero fill must never settle"); },
    store: {
      listUnsettledDogeMartingaleOrders: async () => row.outcome === "zero_fill" || row.settlementResult != null ? [] : [row],
      updateDogeMartingaleOrder: async (update: any) => {
        if (row.filledContracts != null) return false;
        Object.assign(row, update);
        spentCents -= (row.requestedContracts - row.filledContracts) * row.noPriceCents;
        return true;
      },
      settleDogeMartingaleOrder: async () => { settlementCalls++; martingaleStep++; return true; },
    },
  } as any);
  try {
    await reconcileDogeMartingaleSettlements();
    assert.equal(row.outcome, "zero_fill");
    assert.equal(row.filledContracts, 0);
    assert.equal(spentCents, 0, "the entire zero-fill reservation is released");
    assert.equal(martingaleStep, 2, "zero fills do not advance the sequence");
    assert.equal(settlementCalls, 0);
  } finally {
    _setDogeNoMartingaleDependenciesForTesting(null);
  }
});

test("verified partial and full DOGE fills retain their cost and settle exactly once", async () => {
  for (const scenario of [
    { name: "partial", fillCount: "2.00", status: "canceled", requestedContracts: 4, expectedOutcome: "partial_fill", expectedSpent: 50, result: "yes" as const, initialStep: 1, expectedStep: 1 },
    { name: "full-fifth", fillCount: "4.00", status: "filled", requestedContracts: 4, expectedOutcome: "full_fill", expectedSpent: 100, result: "yes" as const, initialStep: 4, expectedStep: 0 },
  ]) {
    const row: any = {
      id: `doge-entry:${scenario.name}`, ticker: "KXDOGE15M-26AUG221200-00", easternDate: "2026-08-22",
      martingaleStep: scenario.initialStep, clientOrderId: `doge-no-${scenario.name}`, kalshiOrderId: null, noPriceCents: 25,
      requestedContracts: scenario.requestedContracts, filledContracts: null, outcome: "unresolved", settlementResult: null,
      createdAtMs: 0, submissionVersion: 1,
    };
    let spentCents = 100;
    let martingaleStep = scenario.initialStep;
    let settlementCalls = 0;
    _setDogeNoMartingaleDependenciesForTesting({
      authFetch: async (_method: string, path: string) => path.startsWith("/portfolio/orders?")
        ? { orders: [{ order_id: `kalshi-${scenario.name}`, client_order_id: row.clientOrderId, ticker: row.ticker }] }
        : { order: { order_id: `kalshi-${scenario.name}`, client_order_id: row.clientOrderId, ticker: row.ticker, status: scenario.status, fill_count_fp: scenario.fillCount } },
      marketFetch: async () => ({ market: { result: scenario.result } }),
      store: {
        listUnsettledDogeMartingaleOrders: async () => row.settlementResult == null ? [row] : [],
        updateDogeMartingaleOrder: async (update: any) => {
          if (row.filledContracts != null) return false;
          Object.assign(row, update);
          spentCents -= (row.requestedContracts - row.filledContracts) * row.noPriceCents;
          return true;
        },
        settleDogeMartingaleOrder: async (id: string, result: "yes" | "no") => {
          assert.equal(id, row.id);
          if (row.settlementResult != null) return false;
          row.settlementResult = result;
          settlementCalls++;
          martingaleStep = result === "no" || row.martingaleStep >= 4 ? 0
            : row.filledContracts < row.requestedContracts ? row.martingaleStep : row.martingaleStep + 1;
          return true;
        },
      },
    } as any);
    try {
      await reconcileDogeMartingaleSettlements();
      await reconcileDogeMartingaleSettlements();
      assert.equal(row.outcome, scenario.expectedOutcome, `${scenario.name} fill is recorded correctly`);
      assert.equal(spentCents, scenario.expectedSpent, `${scenario.name} fill retains only its filled cost`);
      assert.equal(settlementCalls, 1, `${scenario.name} fill settles once`);
      assert.equal(martingaleStep, scenario.expectedStep);
    } finally {
      _setDogeNoMartingaleDependenciesForTesting(null);
    }
  }
});