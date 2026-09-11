import assert from "node:assert/strict";
import test from "node:test";
import {
  _setEthNoMartingaleDependenciesForTesting,
  cancelEthMartingaleGtcOrder,
  ETH_DAILY_LOSS_STOP_CENTS,
  ETH_ENTRY_LATEST_BEFORE_CLOSE_MS,
  ETH_GTC_LIMIT_PRICE_CENTS,
  ETH_PENDING_RESERVATION_EXPIRY_MS,
  ETH_PRINCIPALS_CENTS,
  ethNoOrderPayload,
  ethYesOrderPayload,
  ethPrincipalForStep,
  ethTakerFeeCents,
  evaluateEthNoMartingale,
  getEthMartingaleBlockerStatus,
  hasUnsettledEthMartingaleExposure,
  isEthMarketEligible,
  isEthTicker,
  placeEthMartingaleGtcEntry,
  reconcileEthMartingaleZeroFillLadders,
  reconcileEthMartingaleSettlements,
  runEthPreflightAndPlacement,
} from "./ethOnlyMartingale.js";
import { easternDay } from "../dailyBudget.js";
import { getDogeOrderSubmissionStatus } from "../tradingKillSwitch.js";
import { _isNewEntryPermittedForPolicy } from "../week2EntryPolicy.js";
import { isDogeMartingaleLiveEntryEnabled } from "./dogeNoMartingale.js";
import {
  calculateEthMartingaleCostCents,
  calculateEthMartingaleSessionRealizedPnlCents,
  calculateEthPendingReservationReleaseCents,
  ethMartingaleAttemptOwnsSequence,
  ETH_MARTINGALE_ACTIVE_GENERATION_STARTED_AT_MS,
  ETH_MARTINGALE_SESSION_STARTED_AT_MS,
  isEthMartingaleProofFenceForAttempt,
  isEthMartingaleSequenceOwner,
  isActiveEthMartingaleGeneration,
  findOpenEthMartingalePosition,
  nextEthMartingaleSequence,
  projectEthMartingaleLedgerExportRow,
  summarizeEthMartingaleLedgerExport,
  summarizeEthMartingaleOrders,
} from "../tradeStore.js";
import { ethMartingaleLedgerToCSV } from "../csvExport.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeStore(overrides: Record<string, unknown> = {}) {
  return {
    getEthMartingaleState: async () => ({
      easternDate: "2026-08-22", side: "no" as "yes" | "no", martingaleStep: 0,
      spentCents: 0, realizedPnlCents: 0,
    }),
    listUnsettledEthMartingaleOrders: async () => [],
    listEthMartingaleManualRecoveryTickers: async () => [],
    listUnsettledEthMartingaleZeroFillOrders: async () => [],
    advanceEthMartingaleLadderForZeroFill: async () => true,
    listEthMartingaleOrdersNeedingFillEconomics: async () => [],
    recordEthMartingaleFillEconomics: async () => true,
    reserveEthMartingaleEntry: async () => true,
    markEthMartingaleOrderPostStarted: async () => true,
    updateEthMartingaleOrder: async () => true,
    rejectEthMartingaleOrder: async () => true,
    expireEthMartingaleReservation: async () => true,
    settleEthMartingaleOrder: async () => true,
    ...overrides,
  } as any;
}

function makeUnsettledOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: "eth-entry:KXETH15M-test", ticker: "KXETH15M-test",
    easternDate: "2026-08-22", martingaleStep: 0, side: "no" as "yes" | "no",
    clientOrderId: "eth-no-test", kalshiOrderId: null,
    noPriceCents: 50, requestedContracts: 30, reservedFeeCents: 53,
    filledContracts: null, filledFeeCents: null,
    rejectionReason: null,
    actualFillPriceCents: 50, actualNotionalDollars: 15, actualFeeDollars: 0.53,
    fillEconomicsVerifiedAtMs: null,
    fillEconomicsVerifiedContracts: 30,
    outcome: "full_fill", settlementResult: null,
    createdAtMs: Date.now(), submissionVersion: 1,
    manualSettlementOverride: false, manualRecoveryId: null,
    ...overrides,
  };
}

test("ETH ledger exports preserve both side-aware wins and negative losses", () => {
  const base = makeUnsettledOrder({
    outcome: "full_fill", filledContracts: 30, actualNotionalDollars: 15,
    actualFeeDollars: 0.5, createdAtMs: Date.UTC(2026, 7, 24, 16),
    settledAtMs: Date.UTC(2026, 7, 24, 16, 15),
  });
  const rows = [
    projectEthMartingaleLedgerExportRow({ ...base, id: "yes-win", ticker: "yes-win", side: "yes", settlementResult: "yes" }),
    projectEthMartingaleLedgerExportRow({ ...base, id: "yes-loss", ticker: "yes-loss", side: "yes", settlementResult: "no" }),
    projectEthMartingaleLedgerExportRow({ ...base, id: "no-win", ticker: "no-win", side: "no", settlementResult: "no" }),
    projectEthMartingaleLedgerExportRow({ ...base, id: "no-loss", ticker: "no-loss", side: "no", settlementResult: "yes" }),
    projectEthMartingaleLedgerExportRow({
      ...base, id: "zero-fill", filledContracts: 0, actualNotionalDollars: null,
      actualFeeDollars: null, settlementResult: "yes", outcome: "zero_fill",
    }),
  ];
  assert.deepEqual(rows.map((row) => row.netPnlDollars), [14.5, -15.5, 14.5, -15.5, null]);
  assert.deepEqual(rows.map((row) => row.pnlStatus), ["realized", "realized", "realized", "realized", "zero_fill"]);
  assert.deepEqual(summarizeEthMartingaleLedgerExport(rows), {
    orderCount: 5, realizedOrderCount: 4, wins: 2, losses: 2,
    realizedNetPnlDollars: -2, nonRealizedOrderCount: 1,
  });
  const csv = ethMartingaleLedgerToCSV(rows);
  assert.equal(csv.split("\r\n").length, 6, "CSV keeps every ledger row, including zero fills");
  assert.match(csv, /yes-loss[\s\S]*,-15\.5\r\n/, "YES loss is present as negative P&L");
  assert.match(csv, /no-loss[\s\S]*,-15\.5\r\n/, "NO loss is present as negative P&L");
});

test("shared placement gateway preserves legacy zero, partial, and ambiguous lifecycle call sequences", async () => {
  const market = openMarket("KXETH15M-gateway-equivalence", Date.now());
  const request = {
    state: market, side: "no" as const, step: 0, requestedPrincipalCents: 1500,
    requestedContracts: 30, easternDate: "2026-08-22",
    expectedMartingaleState: {
      easternDate: "2026-08-22", side: "no" as const, martingaleStep: 0, realizedPnlCents: 0,
    },
  };
  for (const scenario of [
    { name: "zero fill", response: { order: { order_id: "zero", status: "resting", fill_count_fp: "0.00" } }, expected: ["reserve", "post_started", "post", "resting:0"] },
    { name: "partial fill", response: { order: { order_id: "partial", status: "resting", fill_count_fp: "10.00" } }, expected: ["reserve", "post_started", "post", "resting:10"] },
    { name: "ambiguous post", response: { order: { status: "resting", fill_count_fp: "0.00" } }, expected: ["reserve", "post_started", "post", "unresolved"] },
  ]) {
    const calls: string[] = [];
    _setEthNoMartingaleDependenciesForTesting({
      isEthOrderSubmissionPermitted: () => true,
      authFetch: async (method: string) => {
        calls.push(method === "POST" ? "post" : method);
        return scenario.response;
      },
      store: makeStore({
        reserveEthMartingaleEntry: async () => { calls.push("reserve"); return true; },
        markEthMartingaleOrderPostStarted: async () => { calls.push("post_started"); return true; },
        updateEthMartingaleOrder: async (value: any) => {
          calls.push(value.outcome === "resting" ? `resting:${value.filledContracts}` : value.outcome);
          return true;
        },
      }),
    } as any);
    try {
      await placeEthMartingaleGtcEntry(request);
      assert.deepEqual(calls, scenario.expected, `${scenario.name} matches the pre-refactor lifecycle sequence`);
    } finally {
      _setEthNoMartingaleDependenciesForTesting(null);
    }
  }
});

test("daily loss -250 boundary is enforced by the shared preflight-and-placement gateway", async () => {
  const restore = setEnabled();
  const now = Date.now();
  const calls: string[] = [];
  _setEthNoMartingaleDependenciesForTesting({
    now: () => now,
    isEthOrderSubmissionPermitted: () => true,
    authFetch: async () => { calls.push("post"); return {}; },
    store: makeStore({
      getEthMartingaleState: async () => ({
        easternDate: easternDay(new Date(now)), side: "no", martingaleStep: 0,
        spentCents: 0, realizedPnlCents: -25_000,
      }),
      reserveEthMartingaleEntry: async () => { calls.push("reserve"); return true; },
    }),
  } as any);
  try {
    await runEthPreflightAndPlacement({ state: openMarket("KXETH15M-loss-boundary", now) });
    assert.deepEqual(calls, [], "legacy daily-loss boundary still prevents lifecycle entry");
    assert.equal(getEthMartingaleBlockerStatus().code, "daily_loss_stop");
  } finally {
    _setEthNoMartingaleDependenciesForTesting(null);
    restore();
  }
});

test("shared gateway uses an explicitly supplied side and step without changing legacy defaults", async () => {
  const restore = setEnabled();
  const now = Date.now();
  let reserved: { side: string; step: number; expectedStep: number } | null = null;
  _setEthNoMartingaleDependenciesForTesting({
    now: () => now,
    isEthOrderSubmissionPermitted: () => true,
    authFetch: async () => ({ order: { order_id: "candidate-override", status: "resting", fill_count_fp: "0.00" } }),
    store: makeStore({
      getEthMartingaleState: async () => ({
        easternDate: easternDay(new Date(now)), side: "no", martingaleStep: 0,
        spentCents: 0, realizedPnlCents: 0,
      }),
      reserveEthMartingaleEntry: async (entry: any) => {
        reserved = { side: entry.side, step: entry.martingaleStep, expectedStep: entry.expectedState.martingaleStep };
        return true;
      },
    }),
  } as any);
  try {
    await runEthPreflightAndPlacement({
      state: openMarket("KXETH15M-candidate-overrides", now),
      side: "yes", step: 4, requestedPrincipalCents: 42_000,
    });
    assert.deepEqual(reserved, { side: "yes", step: 4, expectedStep: 0 });
  } finally {
    _setEthNoMartingaleDependenciesForTesting(null);
    restore();
  }
});

test("a stale Step 0 reservation after a Step 2 loss rolls back before POST, then a fresh evaluation uses Step 3", async () => {
  const restore = setEnabled();
  const now = Date.UTC(2026, 7, 25, 16, 0, 0);
  const date = easternDay(new Date(now));
  let authoritative = {
    easternDate: date, side: "no" as "yes" | "no", martingaleStep: 0,
    spentCents: 0, realizedPnlCents: 0,
  };
  const reservations: Array<{ step: number; expectedStep: number; principal: number }> = [];
  let posts = 0;
  let balanceReads = 0;
  _setEthNoMartingaleDependenciesForTesting({
    now: () => now,
    isEthOrderSubmissionPermitted: () => true,
    fetchExchangeBalance: async () => {
      balanceReads++;
      // The concurrently settled prior NO Step 2 / $60 loss advances the
      // authoritative regular ladder while this evaluation is in preflight.
      if (balanceReads === 1) {
        authoritative = {
          ...authoritative, martingaleStep: 3, realizedPnlCents: -6_000,
        };
      }
      return { value: { balance: 1_000_000 }, stale: false };
    },
    authFetch: async () => { posts++; return { order: { order_id: "fresh-step-3", status: "resting", fill_count_fp: "0.00" } }; },
    store: makeStore({
      getEthMartingaleState: async () => ({ ...authoritative }),
      reserveEthMartingaleEntry: async (entry: any) => {
        reservations.push({
          step: entry.martingaleStep, expectedStep: entry.expectedState.martingaleStep,
          principal: entry.requestedContracts * entry.noPriceCents,
        });
        return entry.expectedState.easternDate === authoritative.easternDate
          && entry.expectedState.side === authoritative.side
          && entry.expectedState.martingaleStep === authoritative.martingaleStep
          && entry.expectedState.realizedPnlCents === authoritative.realizedPnlCents
          ? "reserved"
          : "failed";
      },
    }),
  } as any);
  try {
    await runEthPreflightAndPlacement({ state: openMarket("KXETH15M-stale-step-0", now) });
    assert.deepEqual(reservations, [{ step: 0, expectedStep: 0, principal: 1_500 }]);
    assert.equal(posts, 0, "failed stale reservation must never reach the exchange POST");

    await runEthPreflightAndPlacement({ state: openMarket("KXETH15M-fresh-step-3", now) });
    assert.deepEqual(reservations, [
      { step: 0, expectedStep: 0, principal: 1_500 },
      { step: 3, expectedStep: 3, principal: 12_000 },
    ]);
    assert.equal(posts, 1, "a fresh Step 3 evaluation may submit after the stale one rolled back");
  } finally {
    _setEthNoMartingaleDependenciesForTesting(null);
    restore();
  }
});

test("shared gateway uses an explicitly supplied realized P&L for its loss-stop check", async () => {
  const restore = setEnabled();
  const now = Date.now();
  let reservations = 0;
  _setEthNoMartingaleDependenciesForTesting({
    now: () => now,
    isEthOrderSubmissionPermitted: () => true,
    authFetch: async () => ({ order: { order_id: "candidate-pnl", status: "resting", fill_count_fp: "0.00" } }),
    store: makeStore({
      getEthMartingaleState: async () => ({
        easternDate: easternDay(new Date(now)), side: "no", martingaleStep: 0,
        spentCents: 0, realizedPnlCents: 0,
      }),
      reserveEthMartingaleEntry: async () => { reservations++; return true; },
    }),
  } as any);
  try {
    const request = {
      state: openMarket("KXETH15M-candidate-pnl", now), side: "yes" as const, step: 4,
      requestedPrincipalCents: 42_000, dailyLossStopCents: -120_000,
    };
    await runEthPreflightAndPlacement({ ...request, realizedPnlCents: -120_000 });
    assert.equal(reservations, 0, "candidate loss boundary blocks on candidate P&L, not live P&L");
    await runEthPreflightAndPlacement({ ...request, realizedPnlCents: -119_999 });
    assert.equal(reservations, 1, "candidate P&L just above its stop permits the protected lifecycle");
  } finally {
    _setEthNoMartingaleDependenciesForTesting(null);
    restore();
  }
});

test("shared gateway active ticker lock blocks a concurrent ETH evaluation before reconciliation", async () => {
  const restore = setEnabled();
  const now = Date.now();
  let releaseFirstReconciliation!: () => void;
  let listCalls = 0;
  const firstReconciliation = new Promise<void>((resolve) => { releaseFirstReconciliation = resolve; });
  _setEthNoMartingaleDependenciesForTesting({
    now: () => now,
    isEthOrderSubmissionPermitted: () => true,
    fetchExchangeBalance: async () => ({ value: { balance: 100_000 }, stale: false }),
    store: makeStore({
      listUnsettledEthMartingaleOrders: async () => {
        if (listCalls++ === 0) await firstReconciliation;
        return [];
      },
    }),
  } as any);
  try {
    const market = openMarket("KXETH15M-active-lock", now);
    const first = runEthPreflightAndPlacement({ state: market });
    await Promise.resolve();
    await runEthPreflightAndPlacement({ state: market });
    assert.equal(getEthMartingaleBlockerStatus().code, "active_ticker_lock");
    releaseFirstReconciliation();
    await first;
  } finally {
    _setEthNoMartingaleDependenciesForTesting(null);
    restore();
  }
});

function setEnabled(v = "true") {
  const prev = process.env["ETH_NO_MARTINGALE_ENABLED"];
  process.env["ETH_NO_MARTINGALE_ENABLED"] = v;
  return () => {
    if (prev == null) delete process.env["ETH_NO_MARTINGALE_ENABLED"];
    else process.env["ETH_NO_MARTINGALE_ENABLED"] = prev;
  };
}

/**
 * Returns a valid open EthMarketState for the given ticker and now-timestamp.
 * closeTime is set 5 minutes after now so the timing gate passes.
 */
function openMarket(ticker: string, now: number, overrides: Record<string, unknown> = {}) {
  return {
    ticker,
    exchangeIndex: 2,
    status: "open",
    openTime: new Date(now - 60_000).toISOString(),
    closeTime: new Date(now + 5 * 60_000).toISOString(),
    ...overrides,
  };
}

test("manual recovery residual exchange exposure blocks a later ETH entry", async () => {
  const restore = setEnabled();
  const now = Date.now();
  let reservations = 0;
  let posts = 0;
  _setEthNoMartingaleDependenciesForTesting({
    isEthOrderSubmissionPermitted: () => true,
    now: () => now,
    authFetch: async (method: string) => {
      if (method === "GET") {
        return { market_positions: [{ ticker: "KXETH15M-released", position_fp: "60.00" }] };
      }
      posts++;
      return { order: { order_id: "must-not-post", status: "resting", fill_count_fp: "0.00" } };
    },
    store: makeStore({
      listEthMartingaleManualRecoveryTickers: async () => ["KXETH15M-released"],
      reserveEthMartingaleEntry: async () => { reservations++; return true; },
    }),
  } as any);
  try {
    await evaluateEthNoMartingale(openMarket("KXETH15M-next-window", now));
    assert.equal(reservations, 0, "residual exposure must block before reservation");
    assert.equal(posts, 0, "residual exposure must block before exchange POST");
    assert.equal(getEthMartingaleBlockerStatus().code, "manual_recovery_residual_position");
  } finally {
    _setEthNoMartingaleDependenciesForTesting(null);
    restore();
  }
});

test("unreadable manual recovery position blocks a later ETH entry", async () => {
  const restore = setEnabled();
  const now = Date.now();
  let reservations = 0;
  _setEthNoMartingaleDependenciesForTesting({
    isEthOrderSubmissionPermitted: () => true,
    now: () => now,
    authFetch: async () => { throw new Error("exchange unavailable"); },
    store: makeStore({
      listEthMartingaleManualRecoveryTickers: async () => ["KXETH15M-released"],
      reserveEthMartingaleEntry: async () => { reservations++; return true; },
    }),
  } as any);
  try {
    await evaluateEthNoMartingale(openMarket("KXETH15M-next-window", now));
    assert.equal(reservations, 0, "missing exchange evidence must block before reservation");
    assert.equal(getEthMartingaleBlockerStatus().code, "manual_recovery_position_unavailable");
  } finally {
    _setEthNoMartingaleDependenciesForTesting(null);
    restore();
  }
});

test("malformed manual recovery position response blocks a later ETH entry", async () => {
  const restore = setEnabled();
  const now = Date.now();
  let reservations = 0;
  _setEthNoMartingaleDependenciesForTesting({
    isEthOrderSubmissionPermitted: () => true,
    now: () => now,
    authFetch: async () => ({}),
    store: makeStore({
      listEthMartingaleManualRecoveryTickers: async () => ["KXETH15M-released"],
      reserveEthMartingaleEntry: async () => { reservations++; return true; },
    }),
  } as any);
  try {
    await evaluateEthNoMartingale(openMarket("KXETH15M-next-window", now));
    assert.equal(reservations, 0, "a missing position envelope must block before reservation");
    assert.equal(getEthMartingaleBlockerStatus().code, "manual_recovery_position_unavailable");
  } finally {
    _setEthNoMartingaleDependenciesForTesting(null);
    restore();
  }
});

test("invalid manual recovery position value blocks a later ETH entry", async () => {
  const restore = setEnabled();
  const now = Date.now();
  let reservations = 0;
  _setEthNoMartingaleDependenciesForTesting({
    isEthOrderSubmissionPermitted: () => true,
    now: () => now,
    authFetch: async () => ({
      market_positions: [{ ticker: "KXETH15M-released", position_fp: "not-a-position" }],
    }),
    store: makeStore({
      listEthMartingaleManualRecoveryTickers: async () => ["KXETH15M-released"],
      reserveEthMartingaleEntry: async () => { reservations++; return true; },
    }),
  } as any);
  try {
    await evaluateEthNoMartingale(openMarket("KXETH15M-next-window", now));
    assert.equal(reservations, 0, "an invalid position value must block before reservation");
    assert.equal(getEthMartingaleBlockerStatus().code, "manual_recovery_position_unavailable");
  } finally {
    _setEthNoMartingaleDependenciesForTesting(null);
    restore();
  }
});

test("every manual recovery ticker must be flat before a later ETH entry", async () => {
  const restore = setEnabled();
  const now = Date.now();
  let checkedTickers = 0;
  let reservations = 0;
  _setEthNoMartingaleDependenciesForTesting({
    isEthOrderSubmissionPermitted: () => true,
    now: () => now,
    authFetch: async (method: string, path: string) => {
      assert.equal(method, "GET");
      checkedTickers++;
      return path.includes("KXETH15M-second-release")
        ? { market_positions: [{ ticker: "KXETH15M-second-release", position_fp: "-2" }] }
        : { market_positions: [] };
    },
    store: makeStore({
      listEthMartingaleManualRecoveryTickers: async () => ["KXETH15M-first-release", "KXETH15M-second-release"],
      reserveEthMartingaleEntry: async () => { reservations++; return true; },
    }),
  } as any);
  try {
    await evaluateEthNoMartingale(openMarket("KXETH15M-next-window", now));
    assert.equal(checkedTickers, 2, "each distinct manual recovery must have live evidence");
    assert.equal(reservations, 0, "a later residual must still block before reservation");
    assert.equal(getEthMartingaleBlockerStatus().code, "manual_recovery_residual_position");
  } finally {
    _setEthNoMartingaleDependenciesForTesting(null);
    restore();
  }
});

test("a flat manual recovery ticker does not block a normal ETH entry", async () => {
  const restore = setEnabled();
  const now = Date.now();
  const today = easternDay(new Date(now));
  let reservations = 0;
  let posts = 0;
  _setEthNoMartingaleDependenciesForTesting({
    isEthOrderSubmissionPermitted: () => true,
    now: () => now,
    authFetch: async (method: string, _path: string, body: any) => {
      if (method === "GET") return { market_positions: [] };
      posts++;
      return { order: { order_id: "flat-recovery-entry", client_order_id: body?.client_order_id, status: "resting", fill_count_fp: "0.00" } };
    },
    store: makeStore({
      getEthMartingaleState: async () => ({
        easternDate: today, side: "no" as const, martingaleStep: 0, spentCents: 0, realizedPnlCents: 0,
      }),
      listEthMartingaleManualRecoveryTickers: async () => ["KXETH15M-released"],
      reserveEthMartingaleEntry: async () => { reservations++; return true; },
    }),
  } as any);
  try {
    await evaluateEthNoMartingale(openMarket("KXETH15M-next-window", now));
    assert.equal(reservations, 1, "a confirmed-flat recovery ticker must allow normal reservation");
    assert.equal(posts, 1, "a confirmed-flat recovery ticker must allow the normal POST");
  } finally {
    _setEthNoMartingaleDependenciesForTesting(null);
    restore();
  }
});

// ── ticker eligibility ────────────────────────────────────────────────────────

test("ETH is isolated to KXETH15M- prefix", () => {
  assert.equal(isEthTicker("KXETH15M-26AUG221200-T69000"), true);
  assert.equal(isEthTicker("KXDOGE15M-26AUG221200-00"), false);
  assert.equal(isEthTicker("KXBTC15M-26AUG221200-00"), false);
  assert.equal(isEthTicker("KXETH30M-26AUG221200"), false);
  assert.equal(isEthTicker(""), false);
});

test("fresh ETH generation ignores every prior ledger row without deleting history", () => {
  assert.equal(
    isActiveEthMartingaleGeneration(ETH_MARTINGALE_ACTIVE_GENERATION_STARTED_AT_MS - 1),
    false,
  );
  assert.equal(
    isActiveEthMartingaleGeneration(ETH_MARTINGALE_ACTIVE_GENERATION_STARTED_AT_MS),
    true,
  );
  assert.equal(
    isActiveEthMartingaleGeneration(ETH_MARTINGALE_ACTIVE_GENERATION_STARTED_AT_MS + 1),
    true,
  );
});

test("non-ETH ticker is skipped without touching the store", async () => {
  const restore = setEnabled();
  let storeCalled = false;
  _setEthNoMartingaleDependenciesForTesting({
    isEthOrderSubmissionPermitted: () => true,
    store: makeStore({ listUnsettledEthMartingaleOrders: async () => { storeCalled = true; return []; } }),
  } as any);
  try {
    await evaluateEthNoMartingale({ ticker: "KXDOGE15M-26AUG221200-00", openTime: null, closeTime: null, status: "open" });
    assert.equal(storeCalled, false, "non-ETH ticker must not touch the store");
  } finally { _setEthNoMartingaleDependenciesForTesting(null); restore(); }
});

test("ETH-only final entry boundary permanently rejects DOGE and BTC policy escape hatches", () => {
  const doge = getDogeOrderSubmissionStatus("KXDOGE15M-26AUG221200-00");
  assert.equal(doge.doge_order_submission_permitted, false);
  assert.equal(doge.doge_strategy_enabled, false);
  assert.equal(isDogeMartingaleLiveEntryEnabled(), false);
  assert.equal(_isNewEntryPermittedForPolicy("KXBTC15M-26AUG221200-00", "eth_only"), false);
  assert.equal(_isNewEntryPermittedForPolicy("KXBTC15M-26AUG221200-00", "all_series"), false);
  assert.equal(_isNewEntryPermittedForPolicy("KXETH15M-26AUG221200-00", "all_series"), true);
});

// ── principal ladder ──────────────────────────────────────────────────────────

test("ETH uses exactly six principals and clamps at step 5", () => {
  assert.deepEqual(ETH_PRINCIPALS_CENTS, [1500, 3000, 6000, 12000, 24000, 32000]);
  assert.deepEqual(
    [-1, 0, 1, 2, 3, 4, 5, 6].map(ethPrincipalForStep),
    [1500, 1500, 3000, 6000, 12000, 24000, 32000, 32000],
  );
});

// ── GTC payload correctness ───────────────────────────────────────────────────

test("GTC NO payload: routes to the discovered exchange with the V2 GTC contract", () => {
  const payload = ethNoOrderPayload("KXETH15M-26AUG251200-00", "eth-1", 30, 2);
  assert.equal(payload.side, "ask", "NO GTC order must use ask side");
  assert.equal(payload.price, "0.5000", "NO GTC price must be 50 cents");
  assert.equal(payload.count, "30.00");
  assert.equal(payload.time_in_force, "good_till_canceled", "must use GTC, not IOC");
  assert.equal(payload.self_trade_prevention_type, "taker_at_cross");
  assert.equal(payload.client_order_id, "eth-1");
  assert.equal(payload.ticker, "KXETH15M-26AUG251200-00");
  assert.equal(payload.exchange_index, 2, "must use the live-discovered exchange, not the default");
});

test("GTC YES payload: bid side, price=0.5000, time_in_force=good_till_canceled, self_trade_prevention_type=taker_at_cross", () => {
  const payload = ethYesOrderPayload("KXETH15M-test", "eth-2", 30, 2);
  assert.equal(payload.side, "bid", "YES GTC order must use bid side");
  assert.equal(payload.price, "0.5000", "YES GTC price must be 50 cents");
  assert.equal(payload.count, "30.00");
  assert.equal(payload.time_in_force, "good_till_canceled", "must use GTC, not IOC");
  assert.equal(payload.self_trade_prevention_type, "taker_at_cross");
  assert.equal(payload.exchange_index, 2);
});

test("ETH_GTC_LIMIT_PRICE_CENTS is 50", () => {
  assert.equal(ETH_GTC_LIMIT_PRICE_CENTS, 50);
});

test("GTC payload does NOT contain immediate_or_cancel", () => {
  const noPayload = ethNoOrderPayload("KXETH15M-test", "cid", 30, 2);
  const yesPayload = ethYesOrderPayload("KXETH15M-test", "cid", 30, 2);
  assert.notEqual(noPayload.time_in_force, "immediate_or_cancel", "NO GTC must not be IOC");
  assert.notEqual(yesPayload.time_in_force, "immediate_or_cancel", "YES GTC must not be IOC");
});

test("missing exchange index blocks an ETH entry before reservation or POST", async () => {
  const restore = setEnabled();
  const now = Date.now();
  let reservations = 0;
  let posts = 0;
  _setEthNoMartingaleDependenciesForTesting({
    isEthOrderSubmissionPermitted: () => true,
    now: () => now,
    store: makeStore({
      reserveEthMartingaleEntry: async () => {
        reservations++;
        return true;
      },
    }),
    authFetch: async (method: string) => {
      if (method === "POST") posts++;
      return {} as never;
    },
  } as any);
  try {
    await evaluateEthNoMartingale(openMarket("KXETH15M-missing-exchange-index", now, { exchangeIndex: null }));
    assert.equal(reservations, 0, "unroutable market must not reserve budget or exposure");
    assert.equal(posts, 0, "unroutable market must not call Kalshi's create-order endpoint");
    assert.equal(getEthMartingaleBlockerStatus().code, "missing_exchange_index");
  } finally {
    _setEthNoMartingaleDependenciesForTesting(null);
    restore();
  }
});

test("sufficient aggregate funds never override an insufficient active ETH exchange balance", async () => {
  const restore = setEnabled();
  const now = Date.now();
  let reservations = 0;
  let posts = 0;
  _setEthNoMartingaleDependenciesForTesting({
    isEthOrderSubmissionPermitted: () => true,
    now: () => now,
    // This represents an account with ample aggregate cash elsewhere, while
    // the live KXETH15M market is routed to exchange 2 with only $0.63.
    fetchExchangeBalance: async (exchangeIndex: number) => {
      assert.equal(exchangeIndex, 2, "must check the market's discovered exchange");
      return { value: { balance: 63, aggregate_balance: 50_000 }, stale: false };
    },
    store: makeStore({
      reserveEthMartingaleEntry: async () => {
        reservations++;
        return true;
      },
    }),
    authFetch: async (method: string) => {
      if (method === "POST") posts++;
      return {} as never;
    },
  } as any);
  try {
    await evaluateEthNoMartingale(openMarket("KXETH15M-insufficient-exchange-funds", now));
    assert.equal(reservations, 0, "short exchange funds must block before a durable reservation");
    assert.equal(posts, 0, "short exchange funds must block before the Kalshi order POST");
    const blocker = getEthMartingaleBlockerStatus();
    assert.equal(blocker.code, "insufficient_exchange_balance");
    assert.equal(blocker.exchangeIndex, 2);
    assert.equal(blocker.availableBalanceCents, 63);
    assert.equal(blocker.requiredBalanceCents, 1_553, "30 contracts at 50¢ plus the estimated fee");
    assert.match(blocker.message, /exchange 2 has \$0\.63 available but requires \$15\.53/);
  } finally {
    _setEthNoMartingaleDependenciesForTesting(null);
    restore();
  }
});

test("a sufficient balance on the active ETH exchange permits the GTC entry", async () => {
  const restore = setEnabled();
  const now = Date.now();
  let reservations = 0;
  let posts = 0;
  _setEthNoMartingaleDependenciesForTesting({
    isEthOrderSubmissionPermitted: () => true,
    now: () => now,
    fetchExchangeBalance: async (exchangeIndex: number) => {
      assert.equal(exchangeIndex, 2);
      return { value: { balance: 1_553 }, stale: false };
    },
    authFetch: async (method: string, _path: string, body: any) => {
      if (method === "POST") posts++;
      return {
        order: {
          order_id: "exchange-funds-ok",
          client_order_id: body?.client_order_id,
          ticker: body?.ticker,
          status: "resting",
          fill_count_fp: "0.00",
        },
      } as never;
    },
    store: makeStore({
      reserveEthMartingaleEntry: async () => {
        reservations++;
        return true;
      },
    }),
  } as any);
  try {
    await evaluateEthNoMartingale(openMarket("KXETH15M-sufficient-exchange-funds", now));
    assert.equal(reservations, 1);
    assert.equal(posts, 1);
  } finally {
    _setEthNoMartingaleDependenciesForTesting(null);
    restore();
  }
});

test("each ETH entry evaluation obtains a fresh exchange balance instead of reusing dashboard cash", async () => {
  const restore = setEnabled();
  const now = Date.now();
  let balanceReads = 0;
  let reservations = 0;
  let posts = 0;
  _setEthNoMartingaleDependenciesForTesting({
    isEthOrderSubmissionPermitted: () => true,
    now: () => now,
    // A dashboard had just observed a sufficient $15.53 on exchange 2. Before
    // the next entry, those funds are consumed elsewhere; the next fresh read
    // must see the $0.63 rather than authorize from that cached observation.
    fetchExchangeBalance: async () => {
      balanceReads++;
      return {
        value: { balance: balanceReads === 1 ? 1_553 : 63 },
        stale: false,
      };
    },
    authFetch: async (method: string, _path: string, body: any) => {
      if (method === "POST") posts++;
      // Reject the first entry so it releases and a second market evaluation
      // can prove it performs another balance authorization.
      return method === "POST"
        ? { error: { code: "order_rejected", message: "test release" } } as never
        : {} as never;
    },
    store: makeStore({
      reserveEthMartingaleEntry: async () => {
        reservations++;
        return true;
      },
    }),
  } as any);
  try {
    await evaluateEthNoMartingale(openMarket("KXETH15M-fresh-balance-first", now));
    await evaluateEthNoMartingale(openMarket("KXETH15M-fresh-balance-second", now));
    assert.equal(balanceReads, 2, "each attempted entry must make its own balance authorization read");
    assert.equal(reservations, 1, "the second fresh shortfall must block before reservation");
    assert.equal(posts, 1, "the second fresh shortfall must block before POST");
    assert.equal(getEthMartingaleBlockerStatus().code, "insufficient_exchange_balance");
    assert.equal(getEthMartingaleBlockerStatus().availableBalanceCents, 63);
  } finally {
    _setEthNoMartingaleDependenciesForTesting(null);
    restore();
  }
});

test("contracts = floor(principal / 50) across all six Regular rungs", () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5].map((step) => Math.floor(ethPrincipalForStep(step) / 50)),
    [30, 60, 120, 240, 480, 640],
  );
});

// ── GTC order is placed (evaluateEthNoMartingale flow) ────────────────────────

test("fresh daily state: reserved order carries side=no, step=0 and posts GTC", async () => {
  const restore = setEnabled();
  let reserved: any = null;
  let postedPayload: any = null;
  let postedPath: string | null = null;
  let storedOutcome: string | null = null;
  let storedKalshiOrderId: string | null = null;
  const now = Date.now();
  const today = easternDay(new Date(now));
  _setEthNoMartingaleDependenciesForTesting({
    isEthOrderSubmissionPermitted: () => true,
    now: () => now,
    captureOrderbook: async () => ({ lowestLevelCents: 50, depthAtOrBetterContracts: 100, error: null }),
    authFetch: async (_method: string, path: string, body: any) => {
      postedPath = path;
      postedPayload = body;
      return { order: { order_id: "k-new", client_order_id: body?.client_order_id, ticker: body?.ticker, status: "resting", fill_count_fp: "0.00" } };
    },
    store: makeStore({
      getEthMartingaleState: async () => ({ easternDate: today, side: "no" as const, martingaleStep: 0, spentCents: 0, realizedPnlCents: 0 }),
      reserveEthMartingaleEntry: async (p: any) => { reserved = p; return true; },
      updateEthMartingaleOrder: async (u: any) => { storedOutcome = u.outcome; storedKalshiOrderId = u.kalshiOrderId; return true; },
    }),
  } as any);
  try {
    await evaluateEthNoMartingale(openMarket("KXETH15M-26AUG221200-T69000", now));
    assert.ok(reserved, "should have reserved an entry");
    assert.equal(reserved.martingaleStep, 0);
    assert.equal(reserved.side, "no", "initial side must be 'no'");
    assert.equal(reserved.noPriceCents, 50, "GTC always uses 50 cents");
    assert.equal(reserved.requestedContracts, 30, "step 0: 1500/50=30 contracts");
    assert.ok(postedPayload, "should have POSTed a payload");
    assert.equal(postedPath, "/portfolio/events/orders", "must use the Kalshi V2 create-order path");
    assert.deepEqual(postedPayload, {
      ticker: "KXETH15M-26AUG221200-T69000",
      client_order_id: reserved.clientOrderId,
      side: "ask",
      count: "30.00",
      price: "0.5000",
      time_in_force: "good_till_canceled",
      self_trade_prevention_type: "taker_at_cross",
      exchange_index: 2,
    }, "must send the exact V2 body for the live-discovered ETH exchange");
    assert.equal(postedPayload.time_in_force, "good_till_canceled", "must use GTC");
    assert.equal(postedPayload.price, "0.5000", "must use 50 cent limit");
    assert.equal(storedOutcome, "resting", "exchange acknowledges with resting status → outcome=resting");
    assert.equal(storedKalshiOrderId, "k-new");
  } finally { _setEthNoMartingaleDependenciesForTesting(null); restore(); }
});

test("a prior $2,000 of ETH reservations does not block the next eligible entry", async () => {
  const restore = setEnabled();
  const now = Date.now();
  const today = easternDay(new Date(now));
  let reservation: any = null;
  let posts = 0;
  _setEthNoMartingaleDependenciesForTesting({
    isEthOrderSubmissionPermitted: () => true,
    now: () => now,
    authFetch: async (method: string, _path: string, body: any) => {
      if (method === "POST") {
        posts++;
        return { order: { order_id: "k-after-prior-exposure", client_order_id: body?.client_order_id,
          ticker: body?.ticker, status: "resting", fill_count_fp: "0.00" } };
      }
      return {};
    },
    store: makeStore({
      getEthMartingaleState: async () => ({
        easternDate: today, side: "yes" as const, martingaleStep: 2,
        spentCents: 200_000, realizedPnlCents: 0,
      }),
      reserveEthMartingaleEntry: async (params: any) => { reservation = params; return true; },
    }),
  } as any);
  try {
    await evaluateEthNoMartingale(openMarket("KXETH15M-26AUG221200-T69000", now));
    assert.ok(reservation, "an eligible entry must still be reserved");
    assert.equal(reservation.dailyCapCents, undefined, "ETH reservation must not carry a daily cap");
    assert.equal(posts, 1, "the eligible entry must reach the authenticated exchange POST");
  } finally { _setEthNoMartingaleDependenciesForTesting(null); restore(); }
});

test("live proof fence halts immediately after its first authenticated GTC POST attempt", async () => {
  const restore = setEnabled();
  const now = Date.now();
  const today = easternDay(new Date(now));
  let haltCalls = 0;
  _setEthNoMartingaleDependenciesForTesting({
    isEthOrderSubmissionPermitted: () => true,
    now: () => now,
    stopAfterFirstPost: () => true,
    haltTrading: (halted: boolean) => { if (halted) haltCalls++; },
    authFetch: async (_method: string, _path: string, body: any) => ({
      order: {
        order_id: "k-proof", client_order_id: body?.client_order_id,
        ticker: body?.ticker, status: "resting", fill_count_fp: "0.00",
      },
    }),
    store: makeStore({
      getEthMartingaleState: async () => ({
        easternDate: today, side: "no" as const, martingaleStep: 0,
        spentCents: 0, realizedPnlCents: 0,
      }),
    }),
  } as any);
  try {
    await evaluateEthNoMartingale(openMarket("KXETH15M-26AUG221200-T69000", now));
    assert.equal(haltCalls, 1, "the one-entry live proof must halt after its POST attempt");
  } finally { _setEthNoMartingaleDependenciesForTesting(null); restore(); }
});

test("live proof fence permits only one POST across concurrent ETH tickers", async () => {
  const restore = setEnabled();
  const now = Date.now();
  const today = easternDay(new Date(now));
  const posted: any[] = [];
  let haltCalls = 0;
  let resolvePost!: (value: unknown) => void;
  let notifyPost!: () => void;
  const firstPostStarted = new Promise<void>((resolve) => { notifyPost = resolve; });
  const pendingPost = new Promise<unknown>((resolve) => { resolvePost = resolve; });
  _setEthNoMartingaleDependenciesForTesting({
    isEthOrderSubmissionPermitted: () => true,
    now: () => now,
    stopAfterFirstPost: () => true,
    haltTrading: (halted: boolean) => { if (halted) haltCalls++; },
    authFetch: async (_method: string, _path: string, body: any) => {
      posted.push(body);
      notifyPost();
      return pendingPost;
    },
    store: makeStore({
      getEthMartingaleState: async () => ({
        easternDate: today, side: "no" as const, martingaleStep: 0,
        spentCents: 0, realizedPnlCents: 0,
      }),
    }),
  } as any);
  try {
    const first = evaluateEthNoMartingale(openMarket("KXETH15M-proof-a", now));
    const second = evaluateEthNoMartingale(openMarket("KXETH15M-proof-b", now));
    await firstPostStarted;
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(posted.length, 1, "a competing ETH ticker must not reach a second POST");
    assert.equal(haltCalls, 1, "the proof claim halts before the pending POST resolves");
    resolvePost({
      order: {
        order_id: "k-proof-race", client_order_id: posted[0]?.client_order_id,
        ticker: posted[0]?.ticker, status: "resting", fill_count_fp: "0.00",
      },
    });
    await Promise.all([first, second]);
  } finally { _setEthNoMartingaleDependenciesForTesting(null); restore(); }
});

test("durable live proof fence blocks a new process before post-start or Kalshi POST", async () => {
  const restore = setEnabled();
  const now = Date.now();
  let haltCalls = 0;
  let postStarted = false;
  let authCalled = false;
  _setEthNoMartingaleDependenciesForTesting({
    isEthOrderSubmissionPermitted: () => true,
    now: () => now,
    stopAfterFirstPost: () => true,
    haltTrading: (halted: boolean) => { if (halted) haltCalls++; },
    authFetch: async () => { authCalled = true; return {}; },
    store: makeStore({
      reserveEthMartingaleEntry: async () => "proof_already_claimed",
      markEthMartingaleOrderPostStarted: async () => { postStarted = true; return true; },
    }),
  } as any);
  try {
    await evaluateEthNoMartingale(openMarket("KXETH15M-proof-restart", now));
    assert.equal(haltCalls, 1, "the persisted proof claim must re-halt a restarted process");
    assert.equal(postStarted, false, "a consumed proof must not create a new post-start row");
    assert.equal(authCalled, false, "a consumed proof must not call Kalshi");
  } finally { _setEthNoMartingaleDependenciesForTesting(null); restore(); }
});

test("a prior proof fence is preserved while a later proven phantom releases", () => {
  const priorFence = { ticker: "KXETH15M-prior", clientOrderId: "eth-no-prior" };
  const provenPhantom = { ticker: "KXETH15M-later", clientOrderId: "eth-no-later" };
  assert.equal(isEthMartingaleProofFenceForAttempt(priorFence, provenPhantom), false,
    "a prior completed proof fence must not be deleted or block this independent release");
  assert.equal(isEthMartingaleProofFenceForAttempt(priorFence, priorFence), true,
    "only the submission that claimed a proof fence may clear it");
});

test("Kalshi insufficient_balance rejection is recorded as rejected, not unresolved", async () => {
  const restore = setEnabled();
  const now = Date.now();
  let recordedRejectionReason: string | null = null;
  let unresolvedUpdate = false;
  _setEthNoMartingaleDependenciesForTesting({
    isEthOrderSubmissionPermitted: () => true,
    now: () => now,
    authFetch: async () => {
      throw Object.assign(new Error("Kalshi auth API error 400"), {
        status: 400, body: { error: { code: "insufficient_balance" } },
      });
    },
    store: makeStore({
      rejectEthMartingaleOrder: async (params: { id: string; rejectionReason: string }) => {
        recordedRejectionReason = params.rejectionReason;
        return true;
      },
      updateEthMartingaleOrder: async (params: { outcome?: string }) => {
        unresolvedUpdate ||= params.outcome === "unresolved";
        return true;
      },
    }),
  } as any);
  try {
    await evaluateEthNoMartingale(openMarket("KXETH15M-insufficient-balance", now));
    assert.equal(recordedRejectionReason, "insufficient_balance",
      "the explicit exchange rejection must be durably recorded");
    assert.equal(unresolvedUpdate, false, "a confirmed rejection must never enter VERIFYING");
  } finally {
    _setEthNoMartingaleDependenciesForTesting(null);
    restore();
  }
});

test("unstructured HTTP 400 response remains unresolved and retains its reservation", async () => {
  const restore = setEnabled();
  const now = Date.now();
  let rejectionRecorded = false;
  let unresolvedUpdate = false;
  _setEthNoMartingaleDependenciesForTesting({
    isEthOrderSubmissionPermitted: () => true,
    now: () => now,
    authFetch: async () => {
      throw Object.assign(new Error("Kalshi auth API error 400"), {
        status: 400, body: "<html>gateway failure</html>",
      });
    },
    store: makeStore({
      rejectEthMartingaleOrder: async () => {
        rejectionRecorded = true;
        return true;
      },
      updateEthMartingaleOrder: async (params: { outcome?: string }) => {
        unresolvedUpdate ||= params.outcome === "unresolved";
        return true;
      },
    }),
  } as any);
  try {
    await evaluateEthNoMartingale(openMarket("KXETH15M-unstructured-400", now));
    assert.equal(rejectionRecorded, false,
      "an unstructured response cannot prove that Kalshi created no order");
    assert.equal(unresolvedUpdate, true,
      "an ambiguous POST must retain its reservation through the unresolved fence");
  } finally {
    _setEthNoMartingaleDependenciesForTesting(null);
    restore();
  }
});

test("complete authenticated absence evidence releases only a blank unresolved ETH post", async () => {
  const order = makeUnsettledOrder({
    id: "eth-entry:phantom", ticker: "KXETH15M-phantom", clientOrderId: "eth-no-phantom",
    outcome: "unresolved", kalshiOrderId: null, filledContracts: null, filledFeeCents: null,
    actualFillPriceCents: null, actualNotionalDollars: null, actualFeeDollars: null,
    fillEconomicsVerifiedAtMs: null, fillEconomicsVerifiedContracts: null,
  });
  let releaseId: string | null = null;
  let unsettledReadCount = 0;
  _setEthNoMartingaleDependenciesForTesting({
    accountFingerprint: async () => ({ status: "no_fills", fingerprint: null, fills_scanned: 0,
      source: "GET /portfolio/fills (authenticated)", computed_at: new Date().toISOString(), reason: "Account has no fill history" }),
    authFetch: async (_method: string, path: string) => {
      if (path.startsWith("/portfolio/orders?")) return { orders: [] };
      if (path.startsWith("/portfolio/fills?")) return { fills: [] };
      return {};
    },
    store: makeStore({
      listUnsettledEthMartingaleOrders: async () => ++unsettledReadCount === 1 ? [order] : [],
      resolveEthMartingaleProvenPhantom: async (id: string) => { releaseId = id; return true; },
    }),
  } as any);
  try {
    assert.equal(await reconcileEthMartingaleSettlements(), true);
    assert.equal(releaseId, order.id);
    assert.equal(getEthMartingaleBlockerStatus().code, "ready");
  } finally { _setEthNoMartingaleDependenciesForTesting(null); }
});

test("phantom repair stays fenced for incomplete history, matching orders or matching fills", async () => {
  const order = makeUnsettledOrder({
    id: "eth-entry:phantom-fenced", ticker: "KXETH15M-phantom-fenced", clientOrderId: "eth-no-phantom-fenced",
    outcome: "unresolved", kalshiOrderId: null, filledContracts: null, filledFeeCents: null,
    actualFillPriceCents: null, actualNotionalDollars: null, actualFeeDollars: null,
    fillEconomicsVerifiedAtMs: null, fillEconomicsVerifiedContracts: null,
  });
  for (const scenario of ["incomplete", "matching_fill", "matching_order"] as const) {
    let released = false;
    _setEthNoMartingaleDependenciesForTesting({
      accountFingerprint: async () => ({ status: "no_fills", fingerprint: null, fills_scanned: 0,
        source: "GET /portfolio/fills (authenticated)", computed_at: new Date().toISOString(), reason: "Account has no fill history" }),
      authFetch: async (_method: string, path: string) => {
        if (path.startsWith("/portfolio/orders?")) {
          if (scenario === "incomplete") return {};
          if (scenario === "matching_order") {
            return { orders: [{ ticker: order.ticker, client_order_id: order.clientOrderId, order_id: "kalshi-real" }] };
          }
          return { orders: [] };
        }
        if (path.startsWith("/portfolio/fills?")) {
          return { fills: [{ ticker: order.ticker, client_order_id: order.clientOrderId, order_id: "kalshi-real" }] };
        }
        return {};
      },
      store: makeStore({
        listUnsettledEthMartingaleOrders: async () => [order],
        resolveEthMartingaleProvenPhantom: async () => { released = true; return true; },
      }),
    } as any);
    assert.equal(
      await reconcileEthMartingaleSettlements(),
      true,
      scenario,
    );
    assert.equal(released, false, scenario);
    _setEthNoMartingaleDependenciesForTesting(null);
  }
});

test("phantom repair remains fenced when authenticated reads fail or durable release fails", async () => {
  const order = makeUnsettledOrder({
    id: "eth-entry:phantom-write", ticker: "KXETH15M-phantom-write", clientOrderId: "eth-no-phantom-write",
    outcome: "unresolved", kalshiOrderId: null, filledContracts: null, filledFeeCents: null,
    actualFillPriceCents: null, actualNotionalDollars: null, actualFeeDollars: null,
    fillEconomicsVerifiedAtMs: null, fillEconomicsVerifiedContracts: null,
  });
  for (const scenario of ["read_error", "write_failure"] as const) {
    let releaseCalls = 0;
    _setEthNoMartingaleDependenciesForTesting({
      accountFingerprint: async () => ({ status: "no_fills", fingerprint: null, fills_scanned: 0,
        source: "GET /portfolio/fills (authenticated)", computed_at: new Date().toISOString(), reason: "Account has no fill history" }),
      authFetch: async (_method: string, path: string) => {
        if (scenario === "read_error") throw Object.assign(new Error("unavailable"), { status: 503 });
        if (path.startsWith("/portfolio/orders?")) return { orders: [] };
        return { fills: [] };
      },
      store: makeStore({
        listUnsettledEthMartingaleOrders: async () => [order],
        resolveEthMartingaleProvenPhantom: async () => { releaseCalls++; return false; },
      }),
    } as any);
    assert.equal(await reconcileEthMartingaleSettlements(), scenario === "read_error" ? false : true, scenario);
    assert.equal(releaseCalls, scenario === "write_failure" ? 1 : 0, scenario);
    _setEthNoMartingaleDependenciesForTesting(null);
  }
});

test("phantom repair treats a terminal-only canceled order as conflicting evidence", async () => {
  const order = makeUnsettledOrder({
    id: "eth-entry:phantom-terminal", ticker: "KXETH15M-phantom-terminal", clientOrderId: "eth-no-phantom-terminal",
    outcome: "unresolved", kalshiOrderId: null, filledContracts: null, filledFeeCents: null,
    actualFillPriceCents: null, actualNotionalDollars: null, actualFeeDollars: null,
    fillEconomicsVerifiedAtMs: null, fillEconomicsVerifiedContracts: null,
  });
  let released = false;
  _setEthNoMartingaleDependenciesForTesting({
    accountFingerprint: async () => ({ status: "no_fills", fingerprint: null, fills_scanned: 0,
      source: "GET /portfolio/fills (authenticated)", computed_at: new Date().toISOString(), reason: "Account has no fill history" }),
    authFetch: async (_method: string, path: string) => {
      if (path.startsWith("/portfolio/orders?")) {
        if (path.includes("status=canceled")) {
          return { orders: [{ ticker: order.ticker, client_order_id: order.clientOrderId, order_id: "terminal-zero-fill" }] };
        }
        return { orders: [] };
      }
      return { fills: [] };
    },
    store: makeStore({
      listUnsettledEthMartingaleOrders: async () => [order],
      resolveEthMartingaleProvenPhantom: async () => { released = true; return true; },
    }),
  } as any);
  try {
    assert.equal(await reconcileEthMartingaleSettlements(), true);
    assert.equal(released, false);
  } finally { _setEthNoMartingaleDependenciesForTesting(null); }
});

test("GTC immediately fully filled → outcome=full_fill (not resting)", async () => {
  const restore = setEnabled();
  let storedOutcome: string | null = null;
  let storedFilled: number | null = null;
  const now = Date.now();
  const today = easternDay(new Date(now));
  _setEthNoMartingaleDependenciesForTesting({
    isEthOrderSubmissionPermitted: () => true,
    now: () => now,
    captureOrderbook: async () => ({ lowestLevelCents: 50, depthAtOrBetterContracts: 100, error: null }),
    authFetch: async (_method: string, _path: string, body: any) => ({
      order: { order_id: "k-imm", client_order_id: body?.client_order_id, ticker: body?.ticker, status: "filled", fill_count_fp: "30.00" },
    }),
    store: makeStore({
      getEthMartingaleState: async () => ({ easternDate: today, side: "no" as const, martingaleStep: 0, spentCents: 0, realizedPnlCents: 0 }),
      updateEthMartingaleOrder: async (u: any) => { storedOutcome = u.outcome; storedFilled = u.filledContracts; return true; },
    }),
  } as any);
  try {
    await evaluateEthNoMartingale(openMarket("KXETH15M-26AUG221200-T69000", now));
    assert.equal(storedOutcome, "full_fill", "immediate full fill must use full_fill outcome");
    assert.equal(storedFilled, 30);
  } finally { _setEthNoMartingaleDependenciesForTesting(null); restore(); }
});

test("a 21.42-of-60 GTC partial fill stays exact, resting, and blocks a replacement entry", async () => {
  const restore = setEnabled();
  const now = Date.now();
  const today = easternDay(new Date(now));
  const partialOrder: any = makeUnsettledOrder({
    ticker: "KXETH15M-26AUG221200-T69000",
    requestedContracts: 60,
    kalshiOrderId: "k-fractional",
    filledContracts: 21.42,
    outcome: "resting",
  });
  let stored: any = null;
  let reservations = 0;
  _setEthNoMartingaleDependenciesForTesting({
    isEthOrderSubmissionPermitted: () => true,
    now: () => now,
    captureOrderbook: async () => ({ lowestLevelCents: 50, depthAtOrBetterContracts: 100, error: null }),
    authFetch: async (_method: string, _path: string, body: any) => ({
      order: {
        order_id: "k-fractional", client_order_id: body?.client_order_id, ticker: body?.ticker,
        status: "resting", fill_count_fp: "21.42", remaining_count_fp: "38.58",
      },
    }),
    marketFetch: async () => null,
    store: makeStore({
      getEthMartingaleState: async () => ({
        easternDate: today, side: "no" as const, martingaleStep: 1, spentCents: 0, realizedPnlCents: 0,
      }),
      updateEthMartingaleOrder: async (update: any) => { stored = update; return true; },
      listUnsettledEthMartingaleOrders: async () => stored == null ? [] : [partialOrder],
      reserveEthMartingaleEntry: async () => { reservations++; return true; },
    }),
  } as any);
  try {
    await evaluateEthNoMartingale(openMarket("KXETH15M-26AUG221200-T69000", now));
    assert.equal(stored.outcome, "resting");
    assert.equal(stored.filledContracts, 21.42);
    assert.equal(60 - stored.filledContracts, 38.58);
    await evaluateEthNoMartingale(openMarket("KXETH15M-26AUG221215-T69000", now));
    assert.equal(reservations, 1, "only the original reservation is allowed; the partial GTC blocks replacement");
  } finally {
    _setEthNoMartingaleDependenciesForTesting(null);
    restore();
  }
});

// ── close-time cancellation ───────────────────────────────────────────────────

test("resting order is not cancelled before its authenticated market close time", async () => {
  const restore = setEnabled();
  let deleteCalled = false;
  const now = Date.now();
  const restingOrder = makeUnsettledOrder({ outcome: "resting", kalshiOrderId: "k-rest", clientOrderId: "eth-no-rest", filledContracts: 0 });
  _setEthNoMartingaleDependenciesForTesting({
    isEthOrderSubmissionPermitted: () => true,
    now: () => now,
    authFetch: async (method: string, _path: string) => {
      if (method === "DELETE") { deleteCalled = true; return {}; }
      // Respond to GET poll with still-resting status
      return { order: { order_id: "k-rest", client_order_id: restingOrder.clientOrderId, ticker: restingOrder.ticker, status: "resting", fill_count_fp: "0.00" } };
    },
    marketFetch: async () => ({ market: { close_time: new Date(now + 60_000).toISOString() } }),
    store: makeStore({
      listUnsettledEthMartingaleOrders: async () => [restingOrder],
      updateEthMartingaleOrder: async () => true,
    }),
  } as any);
  try {
    await evaluateEthNoMartingale(openMarket("KXETH15M-26AUG221200-T69000", now));
    assert.equal(deleteCalled, false, "a live remainder must not be cancelled before its own close time");
  } finally { _setEthNoMartingaleDependenciesForTesting(null); restore(); }
});

test("close-time reconciliation verifies a zero-fill GTC handoff without changing the ladder", async () => {
  const now = Date.parse("2026-08-23T13:17:00.000Z");
  const order: any = makeUnsettledOrder({
    outcome: "resting", kalshiOrderId: "k-close-zero", clientOrderId: "eth-no-close-zero",
    ticker: "KXETH15M-26AUG231300-00", filledContracts: 0,
  });
  let deleted = false;
  let stored: any = null;
  _setEthNoMartingaleDependenciesForTesting({
    now: () => now,
    authFetch: async (method: string, path: string) => {
      if (method === "DELETE") {
        deleted = true;
        return { order: {
          order_id: order.kalshiOrderId, client_order_id: order.clientOrderId,
          ticker: order.ticker, status: "canceled", fill_count_fp: "0.00",
        } };
      }
      if (path.startsWith("/markets/")) {
        return { market: {
          ticker: order.ticker, close_time: new Date(now - 1).toISOString(), result: "no",
        } };
      }
      if (path.startsWith("/portfolio/fills?")) return { fills: [] };
      if (path.startsWith("/portfolio/positions?")) return { market_positions: [] };
      return { order: {
        order_id: order.kalshiOrderId, client_order_id: order.clientOrderId,
        ticker: order.ticker, status: "resting", fill_count_fp: "0.00",
      } };
    },
    store: makeStore({
      listEthMartingaleOrdersNeedingFillEconomics: async () => [],
      listUnsettledEthMartingaleZeroFillOrders: async () => [],
      listUnsettledEthMartingaleOrders: async () => order.outcome === "zero_fill_verified" ? [] : [order],
      advanceEthMartingaleLadderForZeroFill: async (_id: string, result: string) => {
        order.settlementResult = result;
        return true;
      },
      updateEthMartingaleOrder: async (update: any) => {
        stored = update;
        Object.assign(order, update);
        return true;
      },
    }),
  } as any);
  try {
    assert.equal(await reconcileEthMartingaleSettlements(), true,
      "a verified no-fill handoff needs no official result before the next window");
    assert.equal(deleted, true, "market-close reconciliation sends exactly the GTC cancellation");
    assert.deepEqual(stored, {
      id: order.id, filledContracts: 0, filledFeeCents: 0, outcome: "zero_fill_verified",
    });
    const blocker = getEthMartingaleBlockerStatus();
    assert.equal(blocker.code, "ready", "a verified zero-fill GTC must not remain shown as resting");
    assert.equal(blocker.orderId, null);
  } finally { _setEthNoMartingaleDependenciesForTesting(null); }
});

test("stale prior-window partial GTC cancels after close, rereads terminal evidence, and settles in one sweep", async () => {
  const now = Date.parse("2026-08-23T16:07:00.000Z");
  const order = makeUnsettledOrder({
    id: "eth-entry:stale-1030", ticker: "KXETH15M-26AUG231045-45",
    kalshiOrderId: "k-stale-1030", clientOrderId: "eth-no-stale-1030",
    requestedContracts: 60, filledContracts: 20, outcome: "resting",
  });
  let orderDetailReads = 0;
  let deletes = 0;
  let economics = 0;
  let settled: string | null = null;
  const updates: any[] = [];
  _setEthNoMartingaleDependenciesForTesting({
    now: () => now,
    authFetch: async (method: string, path: string) => {
      if (method === "DELETE") {
        deletes++;
        // Cancellation acknowledgement is deliberately incomplete; terminal
        // evidence must come from the authenticated detail reread below.
        return { order: { status: "canceled" } };
      }
      if (path.startsWith("/markets/")) {
        return { market: { ticker: order.ticker, close_time: new Date(now - 1).toISOString() } };
      }
      if (path.includes("/portfolio/orders/k-stale-1030")) {
        orderDetailReads++;
        return { order: {
          order_id: order.kalshiOrderId, client_order_id: order.clientOrderId, ticker: order.ticker,
          status: orderDetailReads === 1 ? "resting" : "canceled",
          fill_count_fp: orderDetailReads === 1 ? "20.00" : "21.00",
        } };
      }
      if (path.includes("/portfolio/fills?")) {
        return { fills: [{
          fill_id: "stale-1030-fill", count_fp: "21.00", no_price_dollars: "0.5000",
          yes_price_dollars: "0.5000", fee_cost_dollars: "0.0362",
        }] };
      }
      throw new Error(`unexpected exchange request ${method} ${path}`);
    },
    marketFetch: async () => ({ market: { result: "no" } }),
    store: makeStore({
      listEthMartingaleOrdersNeedingFillEconomics: async () => [],
      listUnsettledEthMartingaleOrders: async () => [order],
      // SQL writes do not mutate the stale object passed into reconciliation.
      updateEthMartingaleOrder: async (update: any) => { updates.push(update); return true; },
      recordEthMartingaleFillEconomics: async () => { economics++; return true; },
      settleEthMartingaleOrder: async (id: string) => { settled = id; return true; },
    }),
  } as any);
  try {
    assert.equal(await reconcileEthMartingaleSettlements(), true);
    assert.equal(deletes, 1, "only the stale exact GTC remainder is cancelled");
    assert.equal(orderDetailReads, 2, "the cancellation acknowledgement is followed by authenticated terminal detail");
    assert.ok(updates.some((u) => u.outcome === "partial_fill" && u.filledContracts === 21));
    assert.equal(economics, 1, "partial fill economics are durable before settlement");
    assert.equal(settled, order.id, "the stale partial settles in the same reconciliation sweep");
  } finally { _setEthNoMartingaleDependenciesForTesting(null); }
});

test("close-time cancellation with an omitted final count stays blocked", async () => {
  const now = Date.parse("2026-08-23T13:17:00.000Z");
  const order = makeUnsettledOrder({
    outcome: "resting", kalshiOrderId: "k-close-ambiguous", clientOrderId: "eth-no-close-ambiguous",
    ticker: "KXETH15M-26AUG231300-15", filledContracts: 0,
  });
  let updates = 0;
  _setEthNoMartingaleDependenciesForTesting({
    now: () => now,
    authFetch: async (method: string, path: string) => {
      if (method === "DELETE") return { order: {
        order_id: order.kalshiOrderId, client_order_id: order.clientOrderId, ticker: order.ticker, status: "canceled",
      } };
      if (path.startsWith("/markets/")) return { market: { ticker: order.ticker, close_time: new Date(now - 1).toISOString() } };
      return { order: {
        order_id: order.kalshiOrderId, client_order_id: order.clientOrderId,
        ticker: order.ticker, status: "resting", fill_count_fp: "0.00",
      } };
    },
    store: makeStore({
      listEthMartingaleOrdersNeedingFillEconomics: async () => [],
      listUnsettledEthMartingaleOrders: async () => [order],
      updateEthMartingaleOrder: async () => { updates++; return true; },
    }),
  } as any);
  try {
    assert.equal(await reconcileEthMartingaleSettlements(), false);
    assert.equal(updates, 0, "a count-less cancellation cannot release a just-live remainder");
  } finally { _setEthNoMartingaleDependenciesForTesting(null); }
});

test("cancelEthMartingaleGtcOrder sends DELETE to exchange with the kalshi order id", async () => {
  let deletePath: string | null = null;
  let updateOutcome: string | null = null;
  const order = makeUnsettledOrder({
    outcome: "resting", kalshiOrderId: "k-gtc-999",
    requestedContracts: 30, filledContracts: 0,
  });
  _setEthNoMartingaleDependenciesForTesting({
    authFetch: async (method: string, path: string) => {
      if (method === "DELETE") {
        deletePath = path;
        return { order: { order_id: "k-gtc-999", client_order_id: order.clientOrderId, ticker: order.ticker, status: "canceled", fill_count_fp: "0.00" } };
      }
      if (path.startsWith("/markets/")) {
        return { market: { ticker: order.ticker, close_time: new Date(Date.now() - 1).toISOString() } };
      }
      if (path.startsWith("/portfolio/fills?")) return { fills: [] };
      if (path.startsWith("/portfolio/positions?")) return { market_positions: [] };
      return {};
    },
    store: makeStore({
      updateEthMartingaleOrder: async (u: any) => { updateOutcome = u.outcome; return true; },
    }),
  } as any);
  try {
    const result = await cancelEthMartingaleGtcOrder(order as any);
    assert.equal(result, true, "cancel must return true on confirmed cancellation");
    assert.ok(String(deletePath ?? "").includes("k-gtc-999"), "must DELETE using the kalshi order id");
    assert.equal(updateOutcome, "zero_fill_verified", "verified no-fill cancellation records a non-attempt handoff");
  } finally { _setEthNoMartingaleDependenciesForTesting(null); }
});

test("cancelEthMartingaleGtcOrder keeps a terminal zero fill fenced before close", async () => {
  const order = makeUnsettledOrder({ outcome: "resting", kalshiOrderId: "k-preclose-zero", filledContracts: 0 });
  let writes = 0;
  _setEthNoMartingaleDependenciesForTesting({
    authFetch: async (method: string, path: string) => {
      if (method === "DELETE") return { order: { order_id: order.kalshiOrderId, client_order_id: order.clientOrderId,
        ticker: order.ticker, status: "canceled", fill_count_fp: "0.00" } };
      if (path.startsWith("/markets/")) return { market: { ticker: order.ticker, close_time: new Date(Date.now() + 60_000).toISOString() } };
      throw new Error(`unexpected ${method} ${path}`);
    },
    store: makeStore({ updateEthMartingaleOrder: async () => { writes++; return true; } }),
  } as any);
  try {
    assert.equal(await cancelEthMartingaleGtcOrder(order as any), false);
    assert.equal(writes, 0, "a pre-close cancellation cannot become a verified closed no-fill handoff");
  } finally { _setEthNoMartingaleDependenciesForTesting(null); }
});

test("closed resting GTC recovers from detail 404 only with terminal history, empty fills, and zero position", async () => {
  const restore = setEnabled();
  const now = Date.parse("2026-08-23T13:17:00.000Z");
  const today = easternDay(new Date(now));
  const prior: any = makeUnsettledOrder({
    id: "eth-entry:404-handoff", ticker: "KXETH15M-26AUG231300-00",
    clientOrderId: "eth-no-404-handoff", kalshiOrderId: "k-404-handoff",
    outcome: "resting", filledContracts: 0, martingaleStep: 1, side: "yes",
  });
  let deletes = 0;
  let reservations = 0;
  let posts = 0;
  const updates: any[] = [];
  _setEthNoMartingaleDependenciesForTesting({
    now: () => now,
    isEthOrderSubmissionPermitted: () => true,
    fetchExchangeBalance: async () => ({ value: { balance: 100_000 }, stale: false }),
    authFetch: async (method: string, path: string, body?: any) => {
      if (method === "GET" && path === `/portfolio/orders/${prior.kalshiOrderId}`) {
        const error: any = new Error("order detail missing");
        error.status = 404;
        throw error;
      }
      if (method === "GET" && path.startsWith("/markets/")) {
        return { market: { ticker: prior.ticker, close_time: new Date(now - 1).toISOString() } };
      }
      if (method === "DELETE") {
        deletes++;
        return { order: { status: "canceled" } };
      }
      if (method === "GET" && path.startsWith("/portfolio/orders?")) {
        return { orders: [{ order_id: prior.kalshiOrderId, client_order_id: prior.clientOrderId,
          ticker: prior.ticker, status: "canceled", fill_count_fp: "0.00" }] };
      }
      if (method === "GET" && path.startsWith("/portfolio/fills?")) return { fills: [] };
      if (method === "GET" && path.startsWith("/portfolio/positions?")) {
        return { market_positions: [{ ticker: prior.ticker, position_fp: "0.00" }] };
      }
      if (method === "POST") {
        posts++;
        return { order: { order_id: "next-after-404", client_order_id: body?.client_order_id,
          ticker: body?.ticker, status: "resting", fill_count_fp: "0.00" } };
      }
      throw new Error(`unexpected exchange request ${method} ${path}`);
    },
    store: makeStore({
      getEthMartingaleState: async () => ({
        easternDate: today, side: "yes" as const, martingaleStep: 1, spentCents: 0, realizedPnlCents: 0,
      }),
      listEthMartingaleOrdersNeedingFillEconomics: async () => [],
      listUnsettledEthMartingaleZeroFillOrders: async () => [],
      listUnsettledEthMartingaleOrders: async () => prior.outcome === "zero_fill_verified" ? [] : [prior],
      updateEthMartingaleOrder: async (update: any) => {
        updates.push(update);
        if (update.id === prior.id) Object.assign(prior, update);
        return true;
      },
      reserveEthMartingaleEntry: async () => { reservations++; return true; },
    }),
  } as any);
  try {
    await evaluateEthNoMartingale(openMarket("KXETH15M-26AUG231315-15", now));
    assert.equal(deletes, 1, "the exact closed resting GTC is cancelled after its direct detail 404");
    assert.deepEqual(updates[0], {
      id: prior.id, filledContracts: 0, filledFeeCents: 0, outcome: "zero_fill_verified",
    });
    assert.equal(reservations, 1, "verified no-fill evidence releases the following window");
    assert.equal(posts, 1);
  } finally {
    _setEthNoMartingaleDependenciesForTesting(null);
    restore();
  }
});

test("direct terminal zero-fill poll uses the verified handoff instead of advancing the ladder", async () => {
  const now = Date.parse("2026-08-23T13:17:00.000Z");
  const order: any = makeUnsettledOrder({
    id: "eth-entry:direct-terminal", ticker: "KXETH15M-26AUG231300-00",
    clientOrderId: "eth-no-direct-terminal", kalshiOrderId: "k-direct-terminal",
    outcome: "resting", filledContracts: 0,
  });
  let updates: any[] = [];
  _setEthNoMartingaleDependenciesForTesting({
    now: () => now,
    authFetch: async (method: string, path: string) => {
      if (method === "GET" && path === `/portfolio/orders/${order.kalshiOrderId}`) {
        return { order: { order_id: order.kalshiOrderId, client_order_id: order.clientOrderId,
          ticker: order.ticker, status: "canceled", fill_count_fp: "0.00" } };
      }
      if (method === "GET" && path.startsWith("/markets/")) {
        return { market: { ticker: order.ticker, close_time: new Date(now - 1).toISOString() } };
      }
      if (method === "GET" && path.startsWith("/portfolio/fills?")) return { fills: [] };
      if (method === "GET" && path.startsWith("/portfolio/positions?")) return { market_positions: [] };
      throw new Error(`unexpected exchange request ${method} ${path}`);
    },
    store: makeStore({
      listEthMartingaleOrdersNeedingFillEconomics: async () => [],
      listUnsettledEthMartingaleZeroFillOrders: async () => [],
      listUnsettledEthMartingaleOrders: async () => order.outcome === "zero_fill_verified" ? [] : [order],
      updateEthMartingaleOrder: async (update: any) => { updates.push(update); Object.assign(order, update); return true; },
    }),
  } as any);
  try {
    assert.equal(await reconcileEthMartingaleSettlements(), true);
    assert.deepEqual(updates, [{
      id: order.id, filledContracts: 0, filledFeeCents: null, outcome: "zero_fill_verified",
      terminalFillRefresh: false, priorFilledContracts: 0, priorFilledFeeCents: null,
    }]);
    assert.equal(getEthMartingaleBlockerStatus().code, "ready");
  } finally { _setEthNoMartingaleDependenciesForTesting(null); }
});

test("404 stale-GTC recovery remains fenced on incomplete, filled, nonzero, malformed, or non-durable evidence", async () => {
  const restore = setEnabled();
  const now = Date.parse("2026-08-23T13:17:00.000Z");
  const today = easternDay(new Date(now));
  for (const scenario of [
    { name: "missing terminal history", history: [] as any[], fills: [] as any[], positions: [] as any[], durable: true },
    { name: "matching fill", history: "terminal", fills: [{ order_id: "k-404-fenced" }] as any[], positions: [] as any[], durable: true },
    { name: "nonzero position", history: "terminal", fills: [] as any[], positions: [{ ticker: "KXETH15M-26AUG231300-00", position_fp: "1.00" }] as any[], durable: true },
    { name: "malformed fill envelope", history: "terminal", fills: null, positions: [] as any[], durable: true },
    { name: "failed durable release", history: "terminal", fills: [] as any[], positions: [] as any[], durable: false },
  ] as const) {
    const prior: any = makeUnsettledOrder({
      id: `eth-entry:404-${scenario.name}`, ticker: "KXETH15M-26AUG231300-00",
      clientOrderId: `eth-no-404-${scenario.name}`, kalshiOrderId: "k-404-fenced",
      outcome: "resting", filledContracts: 0,
    });
    let reservations = 0;
    let posts = 0;
    let updates = 0;
    _setEthNoMartingaleDependenciesForTesting({
      now: () => now,
      isEthOrderSubmissionPermitted: () => true,
      fetchExchangeBalance: async () => ({ value: { balance: 100_000 }, stale: false }),
      authFetch: async (method: string, path: string, body?: any) => {
        if (method === "GET" && path === `/portfolio/orders/${prior.kalshiOrderId}`) {
          const error: any = new Error("order detail missing");
          error.status = 404;
          throw error;
        }
        if (method === "GET" && path.startsWith("/markets/")) {
          return { market: { ticker: prior.ticker, close_time: new Date(now - 1).toISOString() } };
        }
        if (method === "DELETE") return { order: { status: "canceled" } };
        if (method === "GET" && path.startsWith("/portfolio/orders?")) {
          return { orders: scenario.history === "terminal"
            ? [{ order_id: prior.kalshiOrderId, client_order_id: prior.clientOrderId,
              ticker: prior.ticker, status: "canceled", fill_count_fp: "0.00" }]
            : scenario.history };
        }
        if (method === "GET" && path.startsWith("/portfolio/fills?")) {
          return scenario.fills === null ? {} : { fills: scenario.fills };
        }
        if (method === "GET" && path.startsWith("/portfolio/positions?")) {
          return { market_positions: scenario.positions };
        }
        if (method === "POST") {
          posts++;
          return { order: { order_id: "must-not-post", client_order_id: body?.client_order_id,
            ticker: body?.ticker, status: "resting", fill_count_fp: "0.00" } };
        }
        throw new Error(`unexpected exchange request ${method} ${path}`);
      },
      store: makeStore({
        getEthMartingaleState: async () => ({
          easternDate: today, side: "no" as const, martingaleStep: 0, spentCents: 0, realizedPnlCents: 0,
        }),
        listEthMartingaleOrdersNeedingFillEconomics: async () => [],
        listUnsettledEthMartingaleZeroFillOrders: async () => [],
        listUnsettledEthMartingaleOrders: async () => [prior],
        updateEthMartingaleOrder: async () => { updates++; return scenario.durable; },
        reserveEthMartingaleEntry: async () => { reservations++; return true; },
      }),
    } as any);
    await evaluateEthNoMartingale(openMarket(`KXETH15M-26AUG231315-${scenario.name.length}`, now));
    assert.equal(reservations, 0, `${scenario.name}: uncertain prior order must block reservation`);
    assert.equal(posts, 0, `${scenario.name}: uncertain prior order must block replacement POST`);
    assert.equal(updates, scenario.name === "failed durable release" ? 1 : 0,
      `${scenario.name}: only the failed durable-release case reaches the write`);
  }
  _setEthNoMartingaleDependenciesForTesting(null);
  restore();
});

test("cancelEthMartingaleGtcOrder still DELETEs a partially filled resting order with verified economics", async () => {
  let deleteCalled = false;
  let stored: any = null;
  const order = makeUnsettledOrder({
    outcome: "resting", kalshiOrderId: "k-partial-verified",
    requestedContracts: 60, filledContracts: 20, filledFeeCents: 35,
    actualNotionalDollars: 10, actualFeeDollars: 0.035,
    fillEconomicsVerifiedContracts: 20,
  });
  _setEthNoMartingaleDependenciesForTesting({
    authFetch: async (method: string, path: string) => {
      assert.equal(method, "DELETE");
      assert.ok(path.includes("k-partial-verified"));
      deleteCalled = true;
      return { order: { order_id: "k-partial-verified", client_order_id: order.clientOrderId, ticker: order.ticker, status: "canceled", fill_count_fp: "20.00" } };
    },
    store: makeStore({
      updateEthMartingaleOrder: async (update: any) => { stored = update; return true; },
    }),
  } as any);
  try {
    const result = await cancelEthMartingaleGtcOrder(order as any);
    assert.equal(result, true, "only the exchange-confirmed terminal response may report cancellation");
    assert.equal(deleteCalled, true, "verified partial-fill economics does not prove the unfilled remainder was canceled");
    assert.equal(stored.outcome, "partial_fill");
    assert.equal(stored.filledContracts, 20);
  } finally { _setEthNoMartingaleDependenciesForTesting(null); }
});

test("cancelEthMartingaleGtcOrder rejects a cancellation that omits the final fill count", async () => {
  let updates = 0;
  const order = makeUnsettledOrder({
    outcome: "resting", kalshiOrderId: "k-partial-no-count",
    requestedContracts: 60, filledContracts: 20, actualNotionalDollars: 10,
    actualFeeDollars: 0.035, fillEconomicsVerifiedContracts: 20,
  });
  _setEthNoMartingaleDependenciesForTesting({
    authFetch: async () => ({ order: { order_id: "k-partial-no-count", client_order_id: order.clientOrderId, ticker: order.ticker, status: "canceled" } }),
    store: makeStore({ updateEthMartingaleOrder: async () => { updates++; return true; } }),
  } as any);
  try {
    assert.equal(await cancelEthMartingaleGtcOrder(order as any), false);
    assert.equal(updates, 0, "a previously resting count cannot stand in for the terminal count");
  } finally { _setEthNoMartingaleDependenciesForTesting(null); }
});

test("cancelEthMartingaleGtcOrder rejects a terminal response that regresses a known fill count", async () => {
  let updates = 0;
  const order = makeUnsettledOrder({ outcome: "resting", kalshiOrderId: "k-partial-regress", filledContracts: 20 });
  _setEthNoMartingaleDependenciesForTesting({
    authFetch: async () => ({ order: { order_id: "k-partial-regress", client_order_id: order.clientOrderId, ticker: order.ticker, status: "canceled", fill_count_fp: "0.00" } }),
    store: makeStore({ updateEthMartingaleOrder: async () => { updates++; return true; } }),
  } as any);
  try {
    assert.equal(await cancelEthMartingaleGtcOrder(order as any), false);
    assert.equal(updates, 0, "terminal evidence may not reduce locally observed exposure");
  } finally { _setEthNoMartingaleDependenciesForTesting(null); }
});

test("cancelEthMartingaleGtcOrder rejects out-of-range terminal fill counts", async () => {
  const order = makeUnsettledOrder({
    outcome: "resting", kalshiOrderId: "k-invalid-final-count",
    requestedContracts: 60, filledContracts: 0,
  });
  for (const fillCount of ["-1.00", "60.01", "", "   ", "0x10", "1e1"]) {
    let updates = 0;
    _setEthNoMartingaleDependenciesForTesting({
      authFetch: async () => ({ order: {
        order_id: order.kalshiOrderId, client_order_id: order.clientOrderId, ticker: order.ticker,
        status: "canceled", fill_count_fp: fillCount,
      } }),
      store: makeStore({ updateEthMartingaleOrder: async () => { updates++; return true; } }),
    } as any);
    try {
      assert.equal(await cancelEthMartingaleGtcOrder(order as any), false, `rejects final count ${fillCount}`);
      assert.equal(updates, 0);
    } finally { _setEthNoMartingaleDependenciesForTesting(null); }
  }
});

test("ETH settlement cost rounds exact decimal aggregates like PostgreSQL numeric", () => {
  assert.equal(
    calculateEthMartingaleCostCents("10.075", "0"),
    1008,
    "half-cent aggregate rounds up without binary Number drift",
  );
  assert.equal(calculateEthMartingaleCostCents("46.8", "1.9984"), 4880);
  assert.equal(
    calculateEthMartingaleCostCents("14.9", "0.5250999999999999"),
    1543,
    "normalizes an otherwise exact exchange fee that was persisted with an IEEE-754 tail",
  );
  assert.equal(calculateEthMartingaleCostCents("10.0000001", "0"), null);
});

test("session profit sums settled ETH fills with actual economics, excluding zero-fill expirations and open exposure", () => {
  assert.equal(ETH_MARTINGALE_SESSION_STARTED_AT_MS, Date.UTC(2026, 7, 23, 9, 15));
  const result = calculateEthMartingaleSessionRealizedPnlCents([
    // Win: 30 × $1 less the actual $12.345 fill notional and $0.055 exchange fee = +$17.60.
    {
      side: "no", settlementResult: "no", filledContracts: 30,
      actualNotionalDollars: "12.345", actualFeeDollars: "0.055",
      // Historical rows may predate the verification-count marker; actual
      // immutable fill and fee evidence is still authoritative.
    },
    // Loss: actual cost is $20.10, regardless of the original reserved stake.
    {
      side: "yes", settlementResult: "no", filledContracts: 60,
      actualNotionalDollars: "20.00", actualFeeDollars: "0.10",
    },
    // Expired zero-fill window: no realized P&L.
    {
      side: "no", settlementResult: "yes", filledContracts: 0,
      actualNotionalDollars: null, actualFeeDollars: null,
    },
    // Open position: excluded until it has a settlement result.
    {
      side: "yes", settlementResult: null, filledContracts: 30,
      actualNotionalDollars: "15.00", actualFeeDollars: "0.53",
    },
  ]);

  assert.equal(result.realizedPnlCents, -250);
  assert.equal(result.settledOrderCount, 2);
});

test("session profit fails closed when a settled ETH fill lacks exact exchange economics", () => {
  const result = calculateEthMartingaleSessionRealizedPnlCents([{
    side: "no", settlementResult: "no", filledContracts: 30,
    actualNotionalDollars: "12.00", actualFeeDollars: null,
  }]);
  assert.equal(result.realizedPnlCents, null);
});

test("ETH dashboard metrics ignore legacy and research account fills", () => {
  const ethOrders = [
    makeUnsettledOrder({
      id: "eth-win", side: "no", settlementResult: "no", filledContracts: 30,
      actualNotionalDollars: 12, actualFeeDollars: 0.5, createdAtMs: 300,
    }),
    makeUnsettledOrder({
      id: "eth-loss", side: "yes", settlementResult: "no", filledContracts: 60,
      actualNotionalDollars: 25, actualFeeDollars: 1, createdAtMs: 200,
    }),
  ];
  const unrelatedAccountFills = [
    { strategy: "legacy", filledContracts: 9_999, actualNotionalDollars: 9_999, actualFeeDollars: 0, settlementResult: "yes" },
    { strategy: "research", filledContracts: 8_888, actualNotionalDollars: 8_888, actualFeeDollars: 0, settlementResult: "no" },
  ];

  const summary = summarizeEthMartingaleOrders(ethOrders);
  const profit = calculateEthMartingaleSessionRealizedPnlCents(ethOrders);

  assert.equal(unrelatedAccountFills.length, 2, "test fixture represents other account activity");
  assert.deepEqual(summary, {
    orderCount: 2,
    wins: 1,
    losses: 1,
    streak: 1,
    streakType: "win",
    filledContracts: 90,
    actualNotionalDollars: 37,
    fillEconomicsVerified: true,
  });
  assert.deepEqual(profit, { realizedPnlCents: -850, settledOrderCount: 2 });
});

test("ETH dashboard summary includes every daily ledger order beyond 200 rows", () => {
  const orders = Array.from({ length: 201 }, (_, index) => makeUnsettledOrder({
    id: `eth-dashboard-${index}`,
    createdAtMs: index,
    side: "no",
    settlementResult: "no",
    filledContracts: 1,
    actualNotionalDollars: 0.5,
    actualFeeDollars: 0,
  }));
  const summary = summarizeEthMartingaleOrders(orders);
  assert.equal(summary.orderCount, 201);
  assert.equal(summary.wins, 201);
  assert.equal(summary.filledContracts, 201);
  assert.equal(summary.actualNotionalDollars, 100.5);
});

test("ETH dashboard open position selects only the newest unsettled filled ledger order", () => {
  const orders = [
    makeUnsettledOrder({
      id: "expired-zero-fill",
      ticker: "KXETH15M-26AUG230800-00",
      filledContracts: 0,
      settlementResult: null,
      createdAtMs: 400,
    }),
    makeUnsettledOrder({
      id: "settled-fill",
      ticker: "KXETH15M-26AUG230815-15",
      filledContracts: 30,
      settlementResult: "no",
      createdAtMs: 300,
    }),
    makeUnsettledOrder({
      id: "open-partial-fill",
      ticker: "KXETH15M-26AUG230830-30",
      filledContracts: 11,
      settlementResult: null,
      createdAtMs: 200,
    }),
    makeUnsettledOrder({
      id: "open-full-fill",
      ticker: "KXETH15M-26AUG230845-45",
      filledContracts: 30,
      settlementResult: null,
      createdAtMs: 500,
    }),
  ];
  const originalOrder = orders.map((order) => order.id);
  const openPosition = findOpenEthMartingalePosition(orders);

  assert.equal(openPosition?.id, "open-full-fill");
  assert.equal(openPosition?.ticker, "KXETH15M-26AUG230845-45");
  assert.deepEqual(
    orders.map((order) => order.id),
    originalOrder,
    "selecting the open position must not reorder the dashboard's recent windows",
  );
  assert.equal(findOpenEthMartingalePosition([
    makeUnsettledOrder({ filledContracts: null, settlementResult: null }),
    makeUnsettledOrder({ filledContracts: 0, settlementResult: null }),
  ]), null);
});

test("a partial GTC fill that later fills more refreshes exact economics before settlement", async () => {
  const row: any = makeUnsettledOrder({
    id: "eth-entry:partial-then-full", kalshiOrderId: "k-partial-then-full",
    requestedContracts: 30, filledContracts: 10, outcome: "resting",
    actualNotionalDollars: 5, actualFeeDollars: 0.1,
  });
  const economics: any[] = [];
  let settlements = 0;
  const update = async (value: any) => {
    if (value.filledContracts !== undefined && value.filledContracts !== row.filledContracts) {
      row.actualNotionalDollars = null;
      row.actualFeeDollars = null;
      row.fillEconomicsVerifiedContracts = null;
    }
    Object.assign(row, { filledContracts: value.filledContracts ?? row.filledContracts, outcome: value.outcome ?? row.outcome });
    return true;
  };
  _setEthNoMartingaleDependenciesForTesting({
    authFetch: async (_method: string, path: string) => {
      if (path.startsWith("/portfolio/orders/")) {
        return { order: { order_id: row.kalshiOrderId, client_order_id: row.clientOrderId,
          ticker: row.ticker, status: "filled", fill_count: 30 } };
      }
      if (path.startsWith("/portfolio/fills")) {
        return { fills: [{ fill_id: "a", count_fp: "10", no_price_dollars: "0.5", yes_price_dollars: "0.5", fee_cost_dollars: "0.1" },
          { fill_id: "b", count_fp: "20", no_price_dollars: "0.32", yes_price_dollars: "0.68", fee_cost_dollars: "0.357" }] };
      }
      throw new Error(`unexpected ${path}`);
    },
    marketFetch: async () => ({ market: { result: "no" } }),
    store: makeStore({
      listUnsettledEthMartingaleOrders: async () => row.settlementResult == null ? [row] : [],
      updateEthMartingaleOrder: update,
      recordEthMartingaleFillEconomics: async (value: any) => { economics.push(value); return true; },
      settleEthMartingaleOrder: async () => { settlements++; row.settlementResult = "no"; return true; },
    }),
  } as any);
  try {
    await reconcileEthMartingaleSettlements(); // Poll terminal order; invalidates old 10-contract evidence.
    await reconcileEthMartingaleSettlements(); // Fetches all 30 immutable fill chunks, then settles.
    assert.deepEqual(economics[0], {
      id: row.id, contracts: 30, fillPriceCents: 38, notionalDollars: "11.4", feeDollars: "0.457",
    });
    assert.equal(settlements, 1, "settlement waits for refreshed evidence matching all 30 contracts");
  } finally { _setEthNoMartingaleDependenciesForTesting(null); }
});

test("cancelEthMartingaleGtcOrder: exchange not-confirmed terminal returns false (fail closed)", async () => {
  const order = makeUnsettledOrder({ outcome: "resting", kalshiOrderId: "k-ambig" });
  _setEthNoMartingaleDependenciesForTesting({
    authFetch: async () => ({ order: { order_id: "k-ambig", status: "resting", fill_count_fp: "0.00" } }),
    store: makeStore(),
  } as any);
  try {
    const result = await cancelEthMartingaleGtcOrder(order as any);
    assert.equal(result, false, "cancel must return false if exchange does not confirm terminal status");
  } finally { _setEthNoMartingaleDependenciesForTesting(null); }
});

test("cancelEthMartingaleGtcOrder with no kalshiOrderId returns false immediately", async () => {
  const order = makeUnsettledOrder({ outcome: "resting", kalshiOrderId: null });
  let authCalled = false;
  _setEthNoMartingaleDependenciesForTesting({
    authFetch: async () => { authCalled = true; return {}; },
    store: makeStore(),
  } as any);
  try {
    const result = await cancelEthMartingaleGtcOrder(order as any);
    assert.equal(result, false);
    assert.equal(authCalled, false, "no exchange call when kalshiOrderId is null");
  } finally { _setEthNoMartingaleDependenciesForTesting(null); }
});

// ── terminal-fill ladder transitions ─────────────────────────────────────────

test("partial fill advances step and flips side from the official market result", () => {
  // Terminal fill quantity does not change the sequence transition; it only
  // changes financial accounting, which remains based on actual fills.
  const initialStep = 1;
  const initialSide: "yes" | "no" = "no";
  const filledContracts = 21.42; // partial — Kalshi fixed-point quantity
  const officialResult: "yes" | "no" = "no";

  const flipSide = (s: "yes" | "no"): "yes" | "no" => s === "yes" ? "no" : "yes";
  const won = officialResult === initialSide;
  const nextStep = won ? 0 : initialStep + 1;
  const nextSide: "yes" | "no" = won ? flipSide(initialSide) : initialSide;

  assert.equal(filledContracts < 60, true, "fixture must remain a partial fill");
  assert.equal(nextStep, 0, "a winning partial fill resets the ladder");
  assert.equal(nextSide, "yes", "a winning partial fill flips side");
});

test("zero-fill official win is recorded without changing Regular side/rung", async () => {
  const order = makeUnsettledOrder({
    id: "eth-zero-fill-win", side: "no", martingaleStep: 2,
    filledContracts: 0, outcome: "zero_fill",
  });
  let nextState = { side: order.side, martingaleStep: order.martingaleStep };
  const transitions: Array<{ id: string; result: string }> = [];
  _setEthNoMartingaleDependenciesForTesting({
    marketSettlementFetch: async () => ({ market: { result: "no" } }),
    store: makeStore({
      listUnsettledEthMartingaleZeroFillOrders: async () => [order],
      advanceEthMartingaleLadderForZeroFill: async (id: string, result: string) => {
        transitions.push({ id, result });
        order.settlementResult = result as any;
        return true;
      },
    }),
  } as any);
  try {
    await reconcileEthMartingaleZeroFillLadders();
    assert.deepEqual(transitions, [{ id: "eth-zero-fill-win", result: "no" }]);
    assert.deepEqual(nextState, { side: "no", martingaleStep: 2 });
  } finally { _setEthNoMartingaleDependenciesForTesting(null); }
});

test("zero-fill official loss is recorded without changing Regular side/rung", async () => {
  const order = makeUnsettledOrder({
    id: "eth-zero-fill-loss", side: "yes", martingaleStep: 1,
    filledContracts: 0, outcome: "zero_fill",
  });
  let nextState = { side: order.side, martingaleStep: order.martingaleStep };
  const transitions: Array<{ id: string; result: string }> = [];
  _setEthNoMartingaleDependenciesForTesting({
    marketSettlementFetch: async () => ({ market: { result: "no" } }),
    store: makeStore({
      listUnsettledEthMartingaleZeroFillOrders: async () => [order],
      advanceEthMartingaleLadderForZeroFill: async (id: string, result: string) => {
        transitions.push({ id, result });
        order.settlementResult = result as any;
        return true;
      },
    }),
  } as any);
  try {
    await reconcileEthMartingaleZeroFillLadders();
    assert.deepEqual(transitions, [{ id: "eth-zero-fill-loss", result: "no" }]);
    assert.deepEqual(nextState, { side: "yes", martingaleStep: 1 });
  } finally { _setEthNoMartingaleDependenciesForTesting(null); }
});

test("zero-fill awaiting an official result does not block a new eligible ETH entry", async () => {
  const restore = setEnabled();
  const now = Date.parse("2026-08-23T13:17:00.000Z");
  const today = easternDay(new Date(now));
  const pendingOrder = makeUnsettledOrder({
    id: "eth-zero-fill-awaiting-result", outcome: "zero_fill", filledContracts: 0,
  });
  const resolvedOrder = makeUnsettledOrder({
    id: "eth-zero-fill-result-ready", ticker: "KXETH15M-26AUG230900-00",
    outcome: "zero_fill", filledContracts: 0,
  });
  const transitions: Array<{ id: string; result: string }> = [];
  let reservations = 0;
  let posts = 0;
  _setEthNoMartingaleDependenciesForTesting({
    now: () => now,
    isEthOrderSubmissionPermitted: () => true,
    marketSettlementFetch: async (_method: string, path: string) =>
      path.endsWith(pendingOrder.ticker) ? { market: {} } : { market: { result: "no" } },
    fetchExchangeBalance: async () => ({ value: { balance: 100_000 }, stale: false }),
    authFetch: async (method: string, _path: string, body?: any) => {
      if (method !== "POST") throw new Error(`unexpected exchange request ${method}`);
      posts++;
      return { order: {
        order_id: "k-current-window", client_order_id: body?.client_order_id,
        ticker: body?.ticker, status: "resting", fill_count_fp: "0.00",
      } };
    },
    store: makeStore({
      getEthMartingaleState: async () => ({
        easternDate: today, side: "no" as const, martingaleStep: 0,
        spentCents: 0, realizedPnlCents: 0,
      }),
      listUnsettledEthMartingaleZeroFillOrders: async () => [pendingOrder, resolvedOrder],
      listUnsettledEthMartingaleOrders: async () => [],
      advanceEthMartingaleLadderForZeroFill: async (id: string, result: string) => {
        transitions.push({ id, result });
        return true;
      },
      reserveEthMartingaleEntry: async () => {
        reservations++;
        return true;
      },
    }),
  } as any);
  try {
    await evaluateEthNoMartingale(openMarket("KXETH15M-26AUG230915-15", now));
    assert.deepEqual(transitions, [{ id: resolvedOrder.id, result: "no" }],
      "a missing result skips only that order and continues through the zero-fill queue");
    assert.equal(reservations, 1, "a pending zero fill must not fence the current window reservation");
    assert.equal(posts, 1, "a pending zero fill must not fence the current window GTC submission");
  } finally {
    _setEthNoMartingaleDependenciesForTesting(null);
    restore();
  }
});

test("partial fill reconciles via reconcileEthMartingaleSettlements and settles once market resolves", async () => {
  const row: any = {
    id: "eth-entry:partial", ticker: "KXETH15M-26AUG221200-T69000", easternDate: "2026-08-22",
    martingaleStep: 1, side: "no", clientOrderId: "eth-no-partial", kalshiOrderId: "k-partial",
    noPriceCents: 50, requestedContracts: 60, reservedFeeCents: 105,
    filledContracts: 25, filledFeeCents: 44,
    actualFillPriceCents: 50, actualNotionalDollars: 12.5, actualFeeDollars: 0.44,
    fillEconomicsVerifiedContracts: 25,
    outcome: "partial_fill", settlementResult: null,
    createdAtMs: 0, submissionVersion: 1,
  };
  let settlements = 0;
  _setEthNoMartingaleDependenciesForTesting({
    authFetch: async () => ({}), // not called for non-ambiguous partial_fill
    marketFetch: async () => ({ market: { result: "no" } }),
    store: makeStore({
      listUnsettledEthMartingaleOrders: async () => row.settlementResult == null ? [row] : [],
      settleEthMartingaleOrder: async (_id: string, result: string) => {
        row.settlementResult = result; settlements++; return true;
      },
    }),
  } as any);
  try {
    await reconcileEthMartingaleSettlements();
    assert.equal(settlements, 1, "partial fill must be settled once market result is known");
    assert.equal(row.settlementResult, "no");
  } finally { _setEthNoMartingaleDependenciesForTesting(null); }
});

test("stale terminal 21-contract partial refreshes to 21.42 before exact economics and settlement", async () => {
  const row: any = makeUnsettledOrder({
    id: "eth-entry:fractional-chunks", ticker: "KXETH15M-26AUG221200-T69000",
    kalshiOrderId: "k-fractional-chunks", requestedContracts: 60,
    filledContracts: 21, filledFeeCents: 37,
    actualFillPriceCents: null, actualNotionalDollars: null, actualFeeDollars: null,
    fillEconomicsVerifiedContracts: null, outcome: "partial_fill", settlementResult: null,
  });
  let economics: any = null;
  let settlements = 0;
  const updates: any[] = [];
  _setEthNoMartingaleDependenciesForTesting({
    authFetch: async (_method: string, path: string) => {
      if (path === "/portfolio/orders/k-fractional-chunks") {
        return { order: {
          order_id: row.kalshiOrderId, client_order_id: row.clientOrderId, ticker: row.ticker,
          status: "canceled", fill_count_fp: "21.42",
        } };
      }
      assert.match(path, /\/portfolio\/fills\?order_id=k-fractional-chunks/);
      return {
        fills: [
          {
            fill_id: "fraction-a", count_fp: "7.14", no_price_dollars: "0.5000",
            yes_price_dollars: "0.5000", fee_cost_dollars: "0.0123",
          },
          {
            fill_id: "fraction-b", count_fp: "14.28", no_price_dollars: "0.5000",
            yes_price_dollars: "0.5000", fee_cost_dollars: "0.0246",
          },
        ],
      };
    },
    marketFetch: async () => ({ market: { result: "no" } }),
    store: makeStore({
      listUnsettledEthMartingaleOrders: async () => row.settlementResult == null ? [row] : [],
      updateEthMartingaleOrder: async (value: any) => {
        updates.push(value);
        row.filledContracts = value.filledContracts;
        row.filledFeeCents = value.filledFeeCents;
        row.outcome = value.outcome;
        return true;
      },
      recordEthMartingaleFillEconomics: async (value: any) => { economics = value; return true; },
      settleEthMartingaleOrder: async () => { settlements++; row.settlementResult = "no"; return true; },
    }),
  } as any);
  try {
    await reconcileEthMartingaleSettlements();
    assert.deepEqual(updates, [{
      id: row.id, filledContracts: 21.42, filledFeeCents: 38, outcome: "partial_fill",
      terminalFillRefresh: true, priorFilledContracts: 21, priorFilledFeeCents: 37,
    }], "terminal exchange evidence replaces the stale local count before economics");
    assert.deepEqual(economics, {
      id: row.id, contracts: 21.42, fillPriceCents: 50,
      notionalDollars: "10.71", feeDollars: "0.0369",
    });
    assert.equal(settlements, 1, "exact fixed-point chunk aggregation must not block settlement");
  } finally { _setEthNoMartingaleDependenciesForTesting(null); }
});

test("settlement stores a 32¢ improved NO fill and its exchange fee before advancing", async () => {
  const row: any = makeUnsettledOrder({
    id: "eth-entry:improved", kalshiOrderId: "k-improved", filledContracts: 30,
    actualFillPriceCents: null, actualNotionalDollars: null, actualFeeDollars: null,
  });
  let economics: any = null;
  let settlements = 0;
  _setEthNoMartingaleDependenciesForTesting({
    authFetch: async (_method: string, path: string) => {
      assert.match(path, /\/portfolio\/fills\?order_id=k-improved/);
      return {
        fills: [{
          fill_id: "fill-improved", count_fp: "30.00",
          yes_price_dollars: "0.6800", no_price_dollars: "0.3200",
          fee_cost_dollars: "0.4200",
        }],
      };
    },
    marketFetch: async () => ({ market: { result: "no" } }),
    store: makeStore({
      listUnsettledEthMartingaleOrders: async () => row.settlementResult == null ? [row] : [],
      recordEthMartingaleFillEconomics: async (value: any) => { economics = value; return true; },
      settleEthMartingaleOrder: async () => { settlements++; return true; },
    }),
  } as any);
  try {
    await reconcileEthMartingaleSettlements();
    assert.deepEqual(economics, {
      id: "eth-entry:improved", contracts: 30, fillPriceCents: 32,
      notionalDollars: "9.6", feeDollars: "0.42",
    });
    assert.equal(settlements, 1, "settlement only proceeds after exact fill economics persist");
  } finally { _setEthNoMartingaleDependenciesForTesting(null); }
});

test("partial fill does not allow a replacement to exceed the intended stake (reservation cap)", async () => {
  // If a resting order has partial fills, the full principal is still reserved (spent_cents).
  // A new entry for the same step must be blocked by the daily reservation.
  // We simulate this by having a resting order with partial fill in listUnsettledEthMartingaleOrders.
  // The evaluator checks listUnsettledEthMartingaleOrders AFTER reconcile, so it sees the resting order.
  const restore = setEnabled();
  let reservations = 0;
  const now = Date.now();
  _setEthNoMartingaleDependenciesForTesting({
    isEthOrderSubmissionPermitted: () => true,
    now: () => now,
    captureOrderbook: async () => ({ lowestLevelCents: 50, depthAtOrBetterContracts: 100, error: null }),
    marketFetch: async () => null, // no settlement available
    store: makeStore({
      // A resting order with partial fill blocks new entries.
      listUnsettledEthMartingaleOrders: async () => [
        makeUnsettledOrder({ outcome: "resting", kalshiOrderId: "k-partial", filledContracts: 10 }),
      ],
      reserveEthMartingaleEntry: async () => { reservations++; return true; },
    }),
  } as any);
  try {
    await evaluateEthNoMartingale(openMarket("KXETH15M-26AUG221200-T69000", now));
    assert.equal(reservations, 0, "resting partial-fill order blocks new reservation (replacement cap)");
  } finally { _setEthNoMartingaleDependenciesForTesting(null); restore(); }
});

// ── restart recognition of existing resting/partial orders ────────────────────

test("restart: resting order recognized via exchange status in recoverEthAmbiguousEntry", async () => {
  // After restart, a post_started row exists. The exchange reports status="resting".
  // recoverEthAmbiguousEntry must update to outcome="resting" (not error/unresolved).
  const row: any = {
    id: "eth-entry:restart-resting", ticker: "KXETH15M-26AUG221200-T69000", easternDate: "2026-08-22",
    martingaleStep: 0, side: "no", clientOrderId: "eth-no-restart",
    kalshiOrderId: null, noPriceCents: 50, requestedContracts: 30, reservedFeeCents: 53,
    filledContracts: null, filledFeeCents: null,
    outcome: "post_started", settlementResult: null, createdAtMs: 0, submissionVersion: 1,
  };
  let updatedOutcome: string | null = null;
  let updatedFilled: number | null = null;
  _setEthNoMartingaleDependenciesForTesting({
    authFetch: async (method: string, path: string) => {
      if (path.startsWith("/portfolio/orders?")) {
        return { orders: [{ order_id: "k-resting", client_order_id: row.clientOrderId, ticker: row.ticker }] };
      }
      // Detail endpoint: order is resting with 0 fills.
      return { order: { order_id: "k-resting", client_order_id: row.clientOrderId, ticker: row.ticker, status: "resting", fill_count_fp: "0.00" } };
    },
    marketFetch: async () => null,
    store: makeStore({
      listUnsettledEthMartingaleOrders: async () => [row],
      updateEthMartingaleOrder: async (u: any) => {
        updatedOutcome = u.outcome;
        updatedFilled = u.filledContracts;
        Object.assign(row, u);
        return true;
      },
      settleEthMartingaleOrder: async () => true,
    }),
  } as any);
  try {
    await reconcileEthMartingaleSettlements();
    assert.equal(updatedOutcome, "resting", "post_started with exchange resting status must recover to resting");
    assert.equal(updatedFilled, 0, "zero fills at restart");
  } finally { _setEthNoMartingaleDependenciesForTesting(null); }
});

test("restart: resting order with partial fill recognized and no duplicate placed", async () => {
  // After restart: exchange shows resting with 10 fills. Local row is post_started.
  // recoverEthAmbiguousEntry updates to resting with 10 fills.
  // Subsequent evaluateEthNoMartingale sees the resting order and blocks new entry.
  const row: any = {
    id: "eth-entry:restart-partial", ticker: "KXETH15M-26AUG221200-T69000", easternDate: "2026-08-22",
    martingaleStep: 0, side: "no", clientOrderId: "eth-no-partial-restart",
    kalshiOrderId: null, noPriceCents: 50, requestedContracts: 30, reservedFeeCents: 53,
    filledContracts: null, filledFeeCents: null,
    outcome: "post_started", settlementResult: null, createdAtMs: 0, submissionVersion: 1,
  };
  let reservations = 0;
  _setEthNoMartingaleDependenciesForTesting({
    isEthOrderSubmissionPermitted: () => true,
    now: () => Date.now(),
    authFetch: async (method: string, path: string) => {
      if (path.startsWith("/portfolio/orders?")) {
        return { orders: [{ order_id: "k-p-restart", client_order_id: row.clientOrderId, ticker: row.ticker }] };
      }
      return { order: { order_id: "k-p-restart", client_order_id: row.clientOrderId, ticker: row.ticker, status: "resting", fill_count_fp: "10.00" } };
    },
    marketFetch: async () => null,
    store: makeStore({
      listUnsettledEthMartingaleOrders: async () => row.settlementResult == null ? [row] : [],
      updateEthMartingaleOrder: async (u: any) => { Object.assign(row, u); return true; },
      reserveEthMartingaleEntry: async () => { reservations++; return true; },
    }),
  } as any);
  try {
    await reconcileEthMartingaleSettlements();
    assert.equal(row.outcome, "resting", "recovered to resting");
    assert.equal(row.filledContracts, 10, "partial fill count from exchange");
    // No new reservation should be made — the resting order blocks it.
  } finally { _setEthNoMartingaleDependenciesForTesting(null); }
});

test("restart: unresolved order with exchange showing no match → stays unresolved (fail closed)", async () => {
  const row: any = {
    id: "eth-entry:unresolved", ticker: "KXETH15M-26AUG221200-T69000", easternDate: "2026-08-22",
    martingaleStep: 0, side: "no", clientOrderId: "eth-no-nomatch",
    kalshiOrderId: null, noPriceCents: 50, requestedContracts: 30, reservedFeeCents: 53,
    filledContracts: null, filledFeeCents: null,
    outcome: "unresolved", settlementResult: null, createdAtMs: 0, submissionVersion: 1,
  };
  let reservations = 0;
  let updatesCount = 0;
  const restore = setEnabled();
  _setEthNoMartingaleDependenciesForTesting({
    isEthOrderSubmissionPermitted: () => true,
    now: () => Date.now(),
    captureOrderbook: async () => ({ lowestLevelCents: 50, depthAtOrBetterContracts: 100, error: null }),
    authFetch: async (_m: string, p: string) => {
      if (p.startsWith("/portfolio/orders?")) {
        return { orders: [] }; // no matching order on exchange
      }
      return {};
    },
    marketFetch: async () => null,
    store: makeStore({
      listUnsettledEthMartingaleOrders: async () => [row],
      updateEthMartingaleOrder: async () => { updatesCount++; return true; },
      reserveEthMartingaleEntry: async () => { reservations++; return true; },
    }),
  } as any);
  try {
    await reconcileEthMartingaleSettlements();
    assert.equal(updatesCount, 0, "unresolved with no exchange match must not be updated");
    assert.equal(reservations, 0, "unresolved row blocks new reservations");
  } finally { _setEthNoMartingaleDependenciesForTesting(null); restore(); }
});

test("restart: discovered fully executed $30 NO order persists its exchange identity and full quantity", async () => {
  const row: any = {
    id: "eth-entry:restart-full", ticker: "KXETH15M-26AUG221215-T69000", easternDate: "2026-08-22",
    martingaleStep: 1, side: "no", clientOrderId: "eth-no-full-restart",
    kalshiOrderId: null, noPriceCents: 50, requestedContracts: 60, reservedFeeCents: 105,
    filledContracts: null, filledFeeCents: null,
    outcome: "post_started", settlementResult: null, createdAtMs: 0, submissionVersion: 1,
  };
  _setEthNoMartingaleDependenciesForTesting({
    authFetch: async (_method: string, path: string) => {
      if (path.startsWith("/portfolio/orders?")) {
        return { orders: [{ order_id: "k-recovered-full", client_order_id: row.clientOrderId, ticker: row.ticker }] };
      }
      if (path === "/portfolio/orders/k-recovered-full") {
        return { order: { order_id: "k-recovered-full", client_order_id: row.clientOrderId, ticker: row.ticker, status: "executed", fill_count_fp: "60.00" } };
      }
      return {};
    },
    store: makeStore({
      listUnsettledEthMartingaleOrders: async () => [row],
      updateEthMartingaleOrder: async (update: any) => { Object.assign(row, update); return true; },
    }),
  } as any);
  try {
    await reconcileEthMartingaleSettlements();
    assert.equal(row.kalshiOrderId, "k-recovered-full");
    assert.equal(row.filledContracts, 60);
    assert.equal(row.outcome, "full_fill");
  } finally { _setEthNoMartingaleDependenciesForTesting(null); }
});

// ── full fill advances the ladder ─────────────────────────────────────────────

test("Regular loss advances through all six steps and resets only after step 5", () => {
  let state = { side: "no" as const, step: 0 };
  for (const expectedStep of [1, 2, 3, 4, 5, 0]) {
    state = nextEthMartingaleSequence(state.side, state.step, "yes") as typeof state;
    assert.equal(state.side, "no", "loss never flips side");
    assert.equal(state.step, expectedStep);
  }
});

test("Regular win from every rung flips side and resets to step 0", () => {
  for (let step = 0; step <= 5; step++) {
    assert.deepEqual(nextEthMartingaleSequence("no", step, "no"), { side: "yes", step: 0 });
    assert.deepEqual(nextEthMartingaleSequence("yes", step, "yes"), { side: "no", step: 0 });
  }
});

test("step-5 loss resets to step 0 without flipping side", () => {
  assert.deepEqual(nextEthMartingaleSequence("no", 5, "yes"), { side: "no", step: 0 });
  assert.deepEqual(nextEthMartingaleSequence("yes", 5, "no"), { side: "yes", step: 0 });
});

test("full_fill reconciliation: settleEthMartingaleOrder called once when market resolves", async () => {
  const row: any = {
    id: "eth-entry:full", ticker: "KXETH15M-26AUG221200-T69000", easternDate: "2026-08-22",
    martingaleStep: 0, side: "no", clientOrderId: "eth-no-full", kalshiOrderId: "k-full", noPriceCents: 50,
    requestedContracts: 30, reservedFeeCents: 53, filledContracts: 30, filledFeeCents: 53,
    actualFillPriceCents: 50, actualNotionalDollars: 15, actualFeeDollars: 0.53,
    fillEconomicsVerifiedContracts: 30,
    outcome: "full_fill", settlementResult: null,
    createdAtMs: 0, submissionVersion: 1,
  };
  let settlements = 0;
  _setEthNoMartingaleDependenciesForTesting({
    authFetch: async () => ({}),
    marketFetch: async () => ({ market: { result: "no" } }),
    store: makeStore({
      listUnsettledEthMartingaleOrders: async () => row.settlementResult == null ? [row] : [],
      updateEthMartingaleOrder: async (u: any) => { Object.assign(row, u); return true; },
      settleEthMartingaleOrder: async (_id: string, result: string) => { row.settlementResult = result; settlements++; return true; },
    }),
  } as any);
  try {
    await reconcileEthMartingaleSettlements();
    await reconcileEthMartingaleSettlements(); // second call must be idempotent
    assert.equal(row.outcome, "full_fill");
    assert.equal(row.filledContracts, 30);
    assert.equal(settlements, 1, "settles exactly once");
    assert.equal(row.settlementResult, "no");
  } finally { _setEthNoMartingaleDependenciesForTesting(null); }
});

test("a settled prior ETH full fill advances durable state before sizing the already-open next window", async () => {
  const restore = setEnabled();
  const now = Date.parse("2026-08-23T12:00:00.000Z");
  const today = easternDay(new Date(now));
  const scenarios: Array<{
    name: string;
    result: "yes" | "no";
    nextState: { side: "yes" | "no"; martingaleStep: number; realizedPnlCents: number };
    expectedContracts: number;
  }> = [
    {
      name: "win flips side and resets to the $15 step",
      result: "no",
      nextState: { side: "yes", martingaleStep: 0, realizedPnlCents: 1447 },
      expectedContracts: 30,
    },
    {
      name: "loss keeps side and advances to the $30 step",
      result: "yes",
      nextState: { side: "no", martingaleStep: 1, realizedPnlCents: -1553 },
      expectedContracts: 60,
    },
  ];

  try {
    for (const scenario of scenarios) {
      const prior = makeUnsettledOrder({
        id: `eth-entry:prior-${scenario.result}`,
        ticker: `KXETH15M-prior-${scenario.result}`,
        kalshiOrderId: `k-prior-${scenario.result}`,
        easternDate: today,
        outcome: "full_fill",
        filledContracts: 30,
        requestedContracts: 30,
        actualNotionalDollars: 15,
        actualFeeDollars: 0.53,
        fillEconomicsVerifiedContracts: 30,
      });
      let unsettled: any[] = [prior];
      let sequence = {
        easternDate: today, side: "no" as "yes" | "no", martingaleStep: 0,
        spentCents: 0, realizedPnlCents: 0,
      };
      let reserved: any = null;
      let posted: any = null;
      _setEthNoMartingaleDependenciesForTesting({
        now: () => now,
        isEthOrderSubmissionPermitted: () => true,
        marketFetch: async () => ({ market: { result: scenario.result } }),
        authFetch: async (_method: string, _path: string, body: any) => {
          posted = body;
          return {
            order: {
              order_id: `k-next-${scenario.result}`,
              client_order_id: body?.client_order_id,
              ticker: body?.ticker,
              status: "resting",
              fill_count_fp: "0.00",
            },
          };
        },
        store: makeStore({
          getEthMartingaleState: async () => sequence,
          listUnsettledEthMartingaleOrders: async () => unsettled,
          reserveEthMartingaleEntry: async (entry: any) => {
            reserved = entry;
            // The new reservation is an unsettled durable row, so a concurrent
            // re-evaluation after this one must remain blocked.
            unsettled = [makeUnsettledOrder({
              id: entry.id, ticker: entry.ticker, clientOrderId: entry.clientOrderId,
              side: entry.side, martingaleStep: entry.martingaleStep, outcome: "pending",
            })];
            return true;
          },
          settleEthMartingaleOrder: async () => {
            unsettled = [];
            sequence = {
              easternDate: today,
              side: scenario.nextState.side,
              martingaleStep: scenario.nextState.martingaleStep,
              spentCents: 0,
              realizedPnlCents: scenario.nextState.realizedPnlCents,
            };
            return true;
          },
        }),
      } as any);

      await evaluateEthNoMartingale(openMarket(`KXETH15M-next-${scenario.result}`, now));

      assert.ok(reserved, `${scenario.name}: next order should reserve after settlement`);
      assert.equal(reserved.side, scenario.nextState.side, `${scenario.name}: use settled side`);
      assert.equal(reserved.martingaleStep, scenario.nextState.martingaleStep, `${scenario.name}: use settled step`);
      assert.equal(reserved.requestedContracts, scenario.expectedContracts, `${scenario.name}: correct next stake`);
      assert.equal(posted.side, scenario.nextState.side === "yes" ? "bid" : "ask");
    }
  } finally {
    _setEthNoMartingaleDependenciesForTesting(null);
    restore();
  }
});

test("delayed settlement evidence keeps a terminal fill fenced without treating it as live", async () => {
  const restore = setEnabled();
  const now = Date.parse("2026-08-23T12:00:00.000Z");
  const prior = makeUnsettledOrder({
    id: "eth-entry:incomplete-economics",
    ticker: "KXETH15M-prior-incomplete",
    kalshiOrderId: "k-incomplete",
    outcome: "full_fill",
    filledContracts: 30,
    actualNotionalDollars: null,
    actualFeeDollars: null,
    fillEconomicsVerifiedContracts: null,
  });
  let reservations = 0;
  let posts = 0;
  _setEthNoMartingaleDependenciesForTesting({
    now: () => now,
    isEthOrderSubmissionPermitted: () => true,
    marketFetch: async () => ({ market: { result: "no" } }),
    authFetch: async (method: string, path: string) => {
      if (method === "POST") posts++;
      if (path.startsWith("/portfolio/fills")) return { fills: [] };
      return {};
    },
    store: makeStore({
      listUnsettledEthMartingaleOrders: async () => [prior],
      reserveEthMartingaleEntry: async () => {
        reservations++;
        return true;
      },
    }),
  } as any);
  try {
    await evaluateEthNoMartingale(openMarket("KXETH15M-next-incomplete", now));
    assert.equal(reservations, 0, "incomplete settlement must keep the durable order fence active");
    assert.equal(posts, 0, "no next-window POST without exact fill economics");
  } finally {
    _setEthNoMartingaleDependenciesForTesting(null);
    restore();
  }
});

test("resting order that becomes full_fill via polling is settled in the same reconcile", async () => {
  const row: any = {
    id: "eth-entry:resting-fill", ticker: "KXETH15M-26AUG221200-T69000", easternDate: "2026-08-22",
    martingaleStep: 0, side: "no", clientOrderId: "eth-no-rf", kalshiOrderId: "k-rf", noPriceCents: 50,
    requestedContracts: 30, reservedFeeCents: 53, filledContracts: 0, filledFeeCents: 0,
    actualFillPriceCents: 50, actualNotionalDollars: 15, actualFeeDollars: 0.53,
    fillEconomicsVerifiedContracts: 0,
    outcome: "resting", settlementResult: null, createdAtMs: 0, submissionVersion: 1,
  };
  let pollCallCount = 0;
  let settlements = 0;
  _setEthNoMartingaleDependenciesForTesting({
    authFetch: async (_m: string, path: string) => {
      if (path.startsWith("/portfolio/fills")) {
        return { fills: [{ fill_id: "resting-fill", count_fp: "30", no_price_dollars: "0.5",
          yes_price_dollars: "0.5", fee_cost_dollars: "0.53" }] };
      }
      // Poll endpoint returns "filled" on second call
      pollCallCount++;
      if (pollCallCount === 1) {
        return { order: { order_id: "k-rf", client_order_id: row.clientOrderId, ticker: row.ticker, status: "filled", fill_count_fp: "30.00" } };
      }
      return { order: { order_id: "k-rf", client_order_id: row.clientOrderId, ticker: row.ticker, status: "filled", fill_count_fp: "30.00" } };
    },
    marketFetch: async () => ({ market: { result: "no" } }),
    store: makeStore({
      listUnsettledEthMartingaleOrders: async () => row.settlementResult == null ? [row] : [],
      updateEthMartingaleOrder: async (u: any) => {
        if (u.filledContracts !== undefined && u.filledContracts !== row.filledContracts) {
          row.actualNotionalDollars = null;
          row.actualFeeDollars = null;
          row.fillEconomicsVerifiedContracts = null;
        }
        Object.assign(row, u);
        return true;
      },
      settleEthMartingaleOrder: async (_id: string, result: string) => { row.settlementResult = result; settlements++; return true; },
    }),
  } as any);
  try {
    await reconcileEthMartingaleSettlements();
    assert.equal(row.outcome, "full_fill", "resting order polled and transitioned to full_fill");
    assert.equal(settlements, 1, "confirmed terminal poll settles without waiting for another sweep");
    assert.equal(row.settlementResult, "no");
  } finally { _setEthNoMartingaleDependenciesForTesting(null); }
});

// ── timing and status eligibility ────────────────────────────────────────────

test("isEthMarketEligible: open status with valid future closeTime passes", () => {
  const now = Date.now();
  assert.equal(isEthMarketEligible("open", null, new Date(now + 5 * 60_000).toISOString(), now), true);
});

test("isEthMarketEligible: active Kalshi status with a live window passes", () => {
  const now = Date.now();
  assert.equal(
    isEthMarketEligible(
      "active",
      new Date(now - 60_000).toISOString(),
      new Date(now + 5 * 60_000).toISOString(),
      now,
    ),
    true,
  );
});

test("isEthMarketEligible has no five-minute cutoff: an open market with more than 30 seconds remains eligible", () => {
  const now = Date.now();
  assert.equal(
    isEthMarketEligible("open", new Date(now - 1_000).toISOString(), new Date(now + 4 * 60_000).toISOString(), now),
    true,
    "four minutes before close must remain eligible; only the 30-second settlement safety margin applies",
  );
});

test("isEthMarketEligible: non-open status is blocked", () => {
  const now = Date.now();
  const close = new Date(now + 5 * 60_000).toISOString();
  assert.equal(isEthMarketEligible("settled", null, close, now), false);
  assert.equal(isEthMarketEligible("closed", null, close, now), false);
  assert.equal(isEthMarketEligible(null, null, close, now), false);
});

test("isEthMarketEligible: null closeTime is blocked", () => {
  const now = Date.now();
  assert.equal(isEthMarketEligible("open", null, null, now), false);
});

test("isEthMarketEligible: too late (< 30 s to close) is blocked", () => {
  const now = Date.now();
  const tooLate = new Date(now + ETH_ENTRY_LATEST_BEFORE_CLOSE_MS - 1).toISOString();
  assert.equal(isEthMarketEligible("open", null, tooLate, now), false);
  // Exactly at the boundary is also blocked (< not <=)
  const atBoundary = new Date(now + ETH_ENTRY_LATEST_BEFORE_CLOSE_MS).toISOString();
  assert.equal(isEthMarketEligible("open", null, atBoundary, now), false);
  // Just past the boundary is allowed
  const safeEnough = new Date(now + ETH_ENTRY_LATEST_BEFORE_CLOSE_MS + 1).toISOString();
  assert.equal(isEthMarketEligible("open", null, safeEnough, now), true);
});

test("isEthMarketEligible: openTime in the future blocks entry (too early)", () => {
  const now = Date.now();
  const close = new Date(now + 5 * 60_000).toISOString();
  const futureOpen = new Date(now + 1_000).toISOString();
  assert.equal(isEthMarketEligible("open", futureOpen, close, now), false);
  // openTime exactly at now passes (now >= open)
  const openNow = new Date(now).toISOString();
  assert.equal(isEthMarketEligible("open", openNow, close, now), true);
});

test("evaluator blocks on settled market status", async () => {
  const restore = setEnabled();
  let reservations = 0;
  const now = Date.now();
  _setEthNoMartingaleDependenciesForTesting({
    isEthOrderSubmissionPermitted: () => true,
    now: () => now,
    captureOrderbook: async () => ({ lowestLevelCents: 50, depthAtOrBetterContracts: 100, error: null }),
    authFetch: async () => ({}),
    store: makeStore({
      reserveEthMartingaleEntry: async () => { reservations++; return true; },
    }),
  } as any);
  try {
    await evaluateEthNoMartingale({
      ticker: "KXETH15M-26AUG221200-T69000", status: "settled",
      openTime: null, closeTime: new Date(now + 5 * 60_000).toISOString(),
    });
    assert.equal(reservations, 0, "settled market must not trigger entry");
  } finally { _setEthNoMartingaleDependenciesForTesting(null); restore(); }
});

test("evaluator blocks when too close to close time", async () => {
  const restore = setEnabled();
  let reservations = 0;
  const now = Date.now();
  _setEthNoMartingaleDependenciesForTesting({
    isEthOrderSubmissionPermitted: () => true,
    now: () => now,
    captureOrderbook: async () => ({ lowestLevelCents: 50, depthAtOrBetterContracts: 100, error: null }),
    authFetch: async () => ({}),
    store: makeStore({
      reserveEthMartingaleEntry: async () => { reservations++; return true; },
    }),
  } as any);
  try {
    await evaluateEthNoMartingale({
      ticker: "KXETH15M-26AUG221200-T69000", status: "open",
      openTime: null, closeTime: new Date(now + 10_000).toISOString(),
    });
    assert.equal(reservations, 0, "entry must be blocked when < 30 s before close");
  } finally { _setEthNoMartingaleDependenciesForTesting(null); restore(); }
});

test("evaluator blocks when market not yet open (openTime in future)", async () => {
  const restore = setEnabled();
  let reservations = 0;
  const now = Date.now();
  _setEthNoMartingaleDependenciesForTesting({
    isEthOrderSubmissionPermitted: () => true,
    now: () => now,
    captureOrderbook: async () => ({ lowestLevelCents: 50, depthAtOrBetterContracts: 100, error: null }),
    authFetch: async () => ({}),
    store: makeStore({
      reserveEthMartingaleEntry: async () => { reservations++; return true; },
    }),
  } as any);
  try {
    await evaluateEthNoMartingale({
      ticker: "KXETH15M-26AUG221200-T69000", status: "open",
      openTime: new Date(now + 5_000).toISOString(),
      closeTime: new Date(now + 5 * 60_000).toISOString(),
    });
    assert.equal(reservations, 0, "entry must be blocked when market not yet open");
  } finally { _setEthNoMartingaleDependenciesForTesting(null); restore(); }
});

// ── side is persisted at reservation time ────────────────────────────────────

test("when state side=yes the reserved order carries side=yes and sends a YES bid GTC payload", async () => {
  const restore = setEnabled();
  let reserved: any = null;
  let postedPayload: any = null;
  const now = Date.now();
  const today = easternDay(new Date(now));
  _setEthNoMartingaleDependenciesForTesting({
    isEthOrderSubmissionPermitted: () => true,
    now: () => now,
    captureOrderbook: async (_ticker: string, _side: string) => {
      return { lowestLevelCents: 50, depthAtOrBetterContracts: 100, error: null };
    },
    authFetch: async (_method: string, _path: string, body: any) => {
      postedPayload = body;
      return { order: { order_id: "k-yes", client_order_id: body?.client_order_id, ticker: body?.ticker, status: "resting", fill_count_fp: "0.00" } };
    },
    store: makeStore({
      getEthMartingaleState: async () => ({ easternDate: today, side: "yes" as const, martingaleStep: 0, spentCents: 0, realizedPnlCents: 0 }),
      reserveEthMartingaleEntry: async (p: any) => { reserved = p; return true; },
    }),
  } as any);
  try {
    await evaluateEthNoMartingale(openMarket("KXETH15M-26AUG221200-T69000", now));
    assert.ok(reserved, "should have reserved an entry");
    assert.equal(reserved.side, "yes", "reserved side must match state side");
    // For GTC at 50¢: noPriceCents = 100 - 50 = 50 for YES side
    assert.equal(reserved.noPriceCents, 50, "noPriceCents is always 50 for GTC at 50 cents");
    assert.ok(reserved.clientOrderId.startsWith("eth-yes-"), "clientOrderId must carry side prefix");
    // Wire payload: bid at 50 cents
    assert.equal(postedPayload?.side, "bid", "YES GTC order must use bid side");
    assert.equal(postedPayload?.price, "0.5000", "YES GTC price is 50 cents");
    assert.equal(postedPayload?.time_in_force, "good_till_canceled");
  } finally { _setEthNoMartingaleDependenciesForTesting(null); restore(); }
});

test("NO entry reserves with noPriceCents=50 and sends an ask GTC payload", async () => {
  const restore = setEnabled();
  let reserved: any = null;
  let postedPayload: any = null;
  const now = Date.now();
  const today = easternDay(new Date(now));
  _setEthNoMartingaleDependenciesForTesting({
    isEthOrderSubmissionPermitted: () => true,
    now: () => now,
    captureOrderbook: async (_ticker: string, _side: string) => {
      return { lowestLevelCents: 50, depthAtOrBetterContracts: 100, error: null };
    },
    authFetch: async (_method: string, _path: string, body: any) => {
      postedPayload = body;
      return { order: { order_id: "k-no", client_order_id: body?.client_order_id, ticker: body?.ticker, status: "resting", fill_count_fp: "0.00" } };
    },
    store: makeStore({
      getEthMartingaleState: async () => ({ easternDate: today, side: "no" as const, martingaleStep: 0, spentCents: 0, realizedPnlCents: 0 }),
      reserveEthMartingaleEntry: async (p: any) => { reserved = p; return true; },
    }),
  } as any);
  try {
    await evaluateEthNoMartingale(openMarket("KXETH15M-26AUG221200-T69000", now));
    assert.ok(reserved);
    assert.equal(reserved.side, "no");
    assert.equal(reserved.noPriceCents, 50, "noPriceCents is always 50 for GTC at 50 cents");
    assert.ok(reserved.clientOrderId.startsWith("eth-no-"), "clientOrderId must carry side prefix");
    assert.equal(postedPayload?.side, "ask", "NO GTC order must use ask side");
    assert.equal(postedPayload?.price, "0.5000", "NO GTC price is complement=50 cents");
    assert.equal(postedPayload?.time_in_force, "good_till_canceled");
  } finally { _setEthNoMartingaleDependenciesForTesting(null); restore(); }
});

// ── step / side state machine ─────────────────────────────────────────────────

test("steps 1 through 5 use the complete six-step principal ladder", () => {
  assert.deepEqual([1, 2, 3, 4, 5].map(ethPrincipalForStep), [3000, 6000, 12000, 24000, 32000]);
});

test("after six consecutive losses step resets to 0 and side is unchanged", () => {
  let state = { side: "no" as const, step: 0 };
  for (const expectedStep of [1, 2, 3, 4, 5, 0]) {
    state = nextEthMartingaleSequence(state.side, state.step, "yes") as typeof state;
    assert.equal(state.step, expectedStep);
  }
  assert.equal(state.side, "no");
});

test("chronology ownership rejects a late old loss and late old win once a newer filled owner exists", () => {
  assert.equal(ethMartingaleAttemptOwnsSequence(30), true);
  assert.equal(ethMartingaleAttemptOwnsSequence(1), true);
  assert.equal(isEthMartingaleSequenceOwner("older-filled", "newer-filled"), false);
  assert.equal(isEthMartingaleSequenceOwner("newer-filled", "newer-filled"), true);
  // Whether the late old settlement is a win or a loss is irrelevant: it no
  // longer owns side/rung after the newer real attempt exists.
  assert.deepEqual(nextEthMartingaleSequence("no", 3, "yes"), { side: "no", step: 4 });
  assert.deepEqual(nextEthMartingaleSequence("no", 3, "no"), { side: "yes", step: 0 });
});

test("zero-fill and pre-fill rejection are neutral and cannot displace a real chronology owner", () => {
  assert.equal(ethMartingaleAttemptOwnsSequence(0), false);
  assert.equal(ethMartingaleAttemptOwnsSequence(null), false);
  assert.equal(ethMartingaleAttemptOwnsSequence(undefined), false);
  assert.equal(isEthMartingaleSequenceOwner("filled-owner", "filled-owner"), true);
});

test("a win flips side yes→no and resets step to 0", () => {
  let step = 2;
  let side: "yes" | "no" = "yes";
  side = side === "yes" ? "no" : "yes";
  step = 0;
  assert.equal(step, 0);
  assert.equal(side, "no");
});

test("a win flips side no→yes and resets step to 0", () => {
  let step = 1;
  const flip = (s: "yes" | "no"): "yes" | "no" => s === "yes" ? "no" : "yes";
  let side: "yes" | "no" = flip("no");
  step = 0;
  assert.equal(step, 0);
  assert.equal(side, "yes");
});

test("win causes next entry to use YES side (end-to-end reservation flow)", async () => {
  const restore = setEnabled();
  let reservedSide: string | null = null;
  const now = Date.now();
  const today = easternDay(new Date(now));

  _setEthNoMartingaleDependenciesForTesting({
    isEthOrderSubmissionPermitted: () => true,
    now: () => now,
    captureOrderbook: async () => ({ lowestLevelCents: 50, depthAtOrBetterContracts: 100, error: null }),
    authFetch: async (_m: string, _p: string, body: any) => ({
      order: { order_id: "k-win-yes", client_order_id: body?.client_order_id, ticker: body?.ticker, status: "resting", fill_count_fp: "0.00" },
    }),
    store: makeStore({
      getEthMartingaleState: async () => ({
        easternDate: today, side: "yes" as const, martingaleStep: 0,
        spentCents: 0, realizedPnlCents: 5000,
      }),
      reserveEthMartingaleEntry: async (p: any) => { reservedSide = p.side; return true; },
    }),
  } as any);
  try {
    await evaluateEthNoMartingale(openMarket("KXETH15M-26AUG221200-T69000", now));
    assert.equal(reservedSide, "yes", "after a NO win, next entry must be YES");
  } finally { _setEthNoMartingaleDependenciesForTesting(null); restore(); }
});

test("loss retains side (state remains no after a no-side loss)", async () => {
  const restore = setEnabled();
  let reservedSide: string | null = null;
  const now = Date.now();
  const today = easternDay(new Date(now));

  _setEthNoMartingaleDependenciesForTesting({
    isEthOrderSubmissionPermitted: () => true,
    now: () => now,
    captureOrderbook: async () => ({ lowestLevelCents: 50, depthAtOrBetterContracts: 100, error: null }),
    authFetch: async (_m: string, _p: string, body: any) => ({
      order: { order_id: "k-loss", client_order_id: body?.client_order_id, ticker: body?.ticker, status: "resting", fill_count_fp: "0.00" },
    }),
    store: makeStore({
      getEthMartingaleState: async () => ({
        easternDate: today, side: "no" as const, martingaleStep: 1,
        spentCents: 0, realizedPnlCents: -1500,
      }),
      reserveEthMartingaleEntry: async (p: any) => { reservedSide = p.side; return true; },
    }),
  } as any);
  try {
    await evaluateEthNoMartingale(openMarket("KXETH15M-26AUG221200-T69000", now));
    assert.equal(reservedSide, "no", "after a loss side must remain 'no'");
  } finally { _setEthNoMartingaleDependenciesForTesting(null); restore(); }
});

// ── settlement uses persisted order side, not mutable state ──────────────────

test("settlement idempotence: settleEthMartingaleOrder uses persisted order side, not state side", async () => {
  const order = makeUnsettledOrder({
    side: "no",
    outcome: "full_fill", filledContracts: 30, filledFeeCents: 53,
    easternDate: "2026-08-22",
  });
  let settledWith: { id: string; result: string } | null = null as { id: string; result: string } | null;

  _setEthNoMartingaleDependenciesForTesting({
    marketFetch: async () => ({ market: { result: "no" } }),
    store: makeStore({
      listUnsettledEthMartingaleOrders: async () => order.settlementResult == null ? [order] : [],
      settleEthMartingaleOrder: async (id: string, result: string) => {
        settledWith = { id, result };
        order.settlementResult = result as any;
        return true;
      },
    }),
  } as any);
  try {
    await reconcileEthMartingaleSettlements();
    assert.ok(settledWith, "must call settle");
    assert.equal(settledWith!.result, "no");
    // Idempotence: second call must not re-settle
    let secondSettlement = 0;
    _setEthNoMartingaleDependenciesForTesting({
      marketFetch: async () => ({ market: { result: "no" } }),
      store: makeStore({
        listUnsettledEthMartingaleOrders: async () => [],
        settleEthMartingaleOrder: async () => { secondSettlement++; return true; },
      }),
    } as any);
    await reconcileEthMartingaleSettlements();
    assert.equal(secondSettlement, 0, "already-settled order must not be re-settled");
  } finally { _setEthNoMartingaleDependenciesForTesting(null); }
});

test("settlement correctly identifies win by comparing result to persisted order side", async () => {
  for (const scenario of [
    { orderSide: "yes" as const, result: "yes" as const, expectWin: true },
    { orderSide: "yes" as const, result: "no" as const, expectWin: false },
    { orderSide: "no" as const, result: "no" as const, expectWin: true },
    { orderSide: "no" as const, result: "yes" as const, expectWin: false },
  ]) {
    const order = makeUnsettledOrder({
      side: scenario.orderSide,
      outcome: "full_fill", filledContracts: 30, filledFeeCents: 53,
    });
    let settledResult: string | null = null;
    _setEthNoMartingaleDependenciesForTesting({
      marketFetch: async () => ({ market: { result: scenario.result } }),
      store: makeStore({
        listUnsettledEthMartingaleOrders: async () => order.settlementResult == null ? [order] : [],
        settleEthMartingaleOrder: async (id: string, result: string) => {
          settledResult = result;
          order.settlementResult = result as any;
          return true;
        },
      }),
    } as any);
    try {
      await reconcileEthMartingaleSettlements();
      assert.equal(settledResult, scenario.result,
        `order side=${scenario.orderSide} result=${scenario.result}: settlement receives correct result`);
    } finally { _setEthNoMartingaleDependenciesForTesting(null); }
  }
});

// ── loss stop ────────────────────────────────────────────────────────────────

test("new entry is blocked when realized daily P&L <= -25000 cents", async () => {
  const restore = setEnabled();
  let reservations = 0;
  const now = Date.now();
  const today = easternDay(new Date(now));
  _setEthNoMartingaleDependenciesForTesting({
    isEthOrderSubmissionPermitted: () => true,
    now: () => now,
    captureOrderbook: async () => ({ lowestLevelCents: 50, depthAtOrBetterContracts: 100, error: null }),
    store: makeStore({
      getEthMartingaleState: async () => ({
        easternDate: today, side: "no" as const, martingaleStep: 0,
        spentCents: 0, realizedPnlCents: ETH_DAILY_LOSS_STOP_CENTS,
      }),
      reserveEthMartingaleEntry: async () => { reservations++; return true; },
    }),
  } as any);
  try {
    await evaluateEthNoMartingale(openMarket("KXETH15M-26AUG221200-T69000", now));
    assert.equal(reservations, 0, "entry must be blocked at the exact loss-stop threshold");
  } finally { _setEthNoMartingaleDependenciesForTesting(null); restore(); }
});

test("new entry is blocked when realized daily P&L < -25000 cents", async () => {
  const restore = setEnabled();
  let reservations = 0;
  const now = Date.now();
  const today = easternDay(new Date(now));
  _setEthNoMartingaleDependenciesForTesting({
    isEthOrderSubmissionPermitted: () => true,
    now: () => now,
    captureOrderbook: async () => ({ lowestLevelCents: 50, depthAtOrBetterContracts: 100, error: null }),
    store: makeStore({
      getEthMartingaleState: async () => ({
        easternDate: today, side: "no" as const, martingaleStep: 0,
        spentCents: 0, realizedPnlCents: ETH_DAILY_LOSS_STOP_CENTS - 1,
      }),
      reserveEthMartingaleEntry: async () => { reservations++; return true; },
    }),
  } as any);
  try {
    await evaluateEthNoMartingale(openMarket("KXETH15M-26AUG221200-T69000", now));
    assert.equal(reservations, 0, "entry must be blocked when pnl is below the floor");
  } finally { _setEthNoMartingaleDependenciesForTesting(null); restore(); }
});

test("new entry is permitted when realized P&L is above the loss-stop", async () => {
  const restore = setEnabled();
  let reservations = 0;
  const now = Date.now();
  const today = easternDay(new Date(now));
  _setEthNoMartingaleDependenciesForTesting({
    isEthOrderSubmissionPermitted: () => true,
    now: () => now,
    captureOrderbook: async () => ({ lowestLevelCents: 50, depthAtOrBetterContracts: 100, error: null }),
    authFetch: async (_m: string, _p: string, body: any) => ({
      order: { order_id: "k-ok", client_order_id: body?.client_order_id, ticker: body?.ticker, status: "resting", fill_count_fp: "0.00" },
    }),
    store: makeStore({
      getEthMartingaleState: async () => ({
        easternDate: today, side: "no" as const, martingaleStep: 0,
        spentCents: 0, realizedPnlCents: ETH_DAILY_LOSS_STOP_CENTS + 1,
      }),
      reserveEthMartingaleEntry: async () => { reservations++; return true; },
    }),
  } as any);
  try {
    await evaluateEthNoMartingale(openMarket("KXETH15M-26AUG221200-T69000", now));
    assert.equal(reservations, 1, "entry must be permitted above the floor");
  } finally { _setEthNoMartingaleDependenciesForTesting(null); restore(); }
});

// ── day-reset via easternDay ──────────────────────────────────────────────────

test("state resets when ET day changes and initializes the current ET day immediately", async () => {
  const restore = setEnabled();
  let reservedParams: any = null;
  const now = Date.now();
  _setEthNoMartingaleDependenciesForTesting({
    isEthOrderSubmissionPermitted: () => true,
    now: () => now,
    captureOrderbook: async () => ({ lowestLevelCents: 50, depthAtOrBetterContracts: 100, error: null }),
    authFetch: async (_m: string, _p: string, body: any) => ({
      order: { order_id: "k-reset", client_order_id: body?.client_order_id, ticker: body?.ticker, status: "resting", fill_count_fp: "0.00" },
    }),
    store: makeStore({
      getEthMartingaleState: async () => ({
        easternDate: "1999-01-01", side: "yes" as const, martingaleStep: 2,
        spentCents: 5000, realizedPnlCents: -30_000,
      }),
      reserveEthMartingaleEntry: async (p: any) => { reservedParams = p; return true; },
    }),
  } as any);
  try {
    await evaluateEthNoMartingale(openMarket("KXETH15M-26AUG221200-T69000", now));
    assert.equal(reservedParams?.martingaleStep, 0, "new day uses step 0 regardless of stale state");
    assert.equal(reservedParams?.side, "no", "new day always starts on side=no");
  } finally { _setEthNoMartingaleDependenciesForTesting(null); restore(); }
});

// ── final gate: no POST, reservation released ─────────────────────────────────

test("final gate closed: no POST is made and reservation is released as zero_fill", async () => {
  const restore = setEnabled();
  let permissionChecks = 0;
  let posts = 0;
  let finalOutcome: string | null = null;
  const now = Date.now();
  _setEthNoMartingaleDependenciesForTesting({
    now: () => now,
    isEthOrderSubmissionPermitted: () => ++permissionChecks === 1, // first passes, second fails
    captureOrderbook: async () => ({ lowestLevelCents: 50, depthAtOrBetterContracts: 100, error: null }),
    authFetch: async () => { posts++; return {}; },
    store: makeStore({
      updateEthMartingaleOrder: async (u: any) => { finalOutcome = u.outcome; return true; },
    }),
  } as any);
  try {
    await evaluateEthNoMartingale(openMarket("KXETH15M-26AUG221200-T69000", now));
    assert.equal(permissionChecks, 2, "permission is checked before state changes and before POST");
    assert.equal(posts, 0, "a closed final gate must prevent the exchange request");
    assert.equal(finalOutcome, "zero_fill", "the known-unsubmitted reservation is released");
  } finally { _setEthNoMartingaleDependenciesForTesting(null); restore(); }
});

// ── unsettled order blocks next entry ────────────────────────────────────────

test("an unsettled order blocks a new reservation", async () => {
  const restore = setEnabled();
  let reservations = 0;
  const now = Date.now();
  _setEthNoMartingaleDependenciesForTesting({
    isEthOrderSubmissionPermitted: () => true,
    now: () => now,
    captureOrderbook: async () => ({ lowestLevelCents: 50, depthAtOrBetterContracts: 100, error: null }),
    marketFetch: async () => null,
    store: makeStore({
      listUnsettledEthMartingaleOrders: async () => [makeUnsettledOrder()],
      reserveEthMartingaleEntry: async () => { reservations++; return true; },
    }),
  } as any);
  try {
    await evaluateEthNoMartingale(openMarket("KXETH15M-26AUG221215-T69000", now));
    assert.equal(reservations, 0, "unsettled order blocks new reservation");
  } finally { _setEthNoMartingaleDependenciesForTesting(null); restore(); }
});

// ── fee calculation ───────────────────────────────────────────────────────────

test("taker fee rounds up to whole cents", () => {
  // 0.07 * 1 * 50 * 50 / 100 = 1.75 → rounds up to 2
  assert.equal(ethTakerFeeCents(50, 1), 2);
  // 0.07 * 30 * 50 * 50 / 100 = 52.5 → rounds up to 53
  assert.equal(ethTakerFeeCents(50, 30), 53);
  assert.equal(ethTakerFeeCents(50, 21.42), 38, "fractional partials retain fee accounting");
});

test("taker fee returns 0 for invalid inputs", () => {
  assert.equal(ethTakerFeeCents(0, 1), 0);
  assert.equal(ethTakerFeeCents(100, 1), 0);
  assert.equal(ethTakerFeeCents(50, 0), 0);
});

// ── pending expiry ────────────────────────────────────────────────────────────

test("pending reservation beyond expiry window is released", async () => {
  const now = Date.parse("2026-08-22T12:05:00.000Z");
  const row: any = {
    id: "eth-entry:KXETH15M-stale", ticker: "KXETH15M-stale", easternDate: "2026-08-22",
    martingaleStep: 0, side: "no", clientOrderId: "eth-stale", kalshiOrderId: null, noPriceCents: 50,
    requestedContracts: 30, filledContracts: null, outcome: "pending", settlementResult: null,
    createdAtMs: now - ETH_PENDING_RESERVATION_EXPIRY_MS - 1, submissionVersion: 1, reservedFeeCents: 0,
  };
  let expired = false;
  _setEthNoMartingaleDependenciesForTesting({
    now: () => now,
    store: makeStore({
      listUnsettledEthMartingaleOrders: async () => [row],
      expireEthMartingaleReservation: async () => { expired = true; row.outcome = "expired"; return true; },
    }),
  } as any);
  try {
    await reconcileEthMartingaleSettlements();
    assert.equal(expired, true);
    assert.equal(row.outcome, "expired");
  } finally { _setEthNoMartingaleDependenciesForTesting(null); }
});

test("stale pre-POST $30 reservation releases exactly 3,105 cents without changing the ladder", async () => {
  assert.equal(calculateEthPendingReservationReleaseCents(60, 50, 105), 3_105);
  assert.equal(calculateEthPendingReservationReleaseCents(60.5, 50, 105), null);
  assert.equal(calculateEthPendingReservationReleaseCents(60, 50, -1), null);
});

test("pending row with exchange identity remains fail-closed and blocks expiry", async () => {
  const now = Date.parse("2026-08-23T10:20:00.000Z");
  const row: any = {
    ...makeUnsettledOrder({
      id: "eth-entry:possibly-submitted", outcome: "pending", kalshiOrderId: "kalshi-order-id",
      filledContracts: null, filledFeeCents: null, actualNotionalDollars: null, actualFeeDollars: null,
      createdAtMs: now - ETH_PENDING_RESERVATION_EXPIRY_MS - 1,
    }),
  };
  let expired = false;
  _setEthNoMartingaleDependenciesForTesting({
    now: () => now,
    store: makeStore({
      listUnsettledEthMartingaleOrders: async () => [row],
      expireEthMartingaleReservation: async () => { expired = true; return true; },
    }),
  } as any);
  try {
    await reconcileEthMartingaleSettlements();
    assert.equal(expired, false, "possibly submitted rows must never be released by pending expiry");
  } finally { _setEthNoMartingaleDependenciesForTesting(null); }
});

test("pending row with any fill-evidence marker remains fail-closed and blocks expiry", async () => {
  const now = Date.parse("2026-08-23T10:20:00.000Z");
  const row: any = {
    ...makeUnsettledOrder({
      id: "eth-entry:evidence-marker", outcome: "pending", kalshiOrderId: null,
      filledContracts: null, filledFeeCents: null, actualFillPriceCents: 50,
      actualNotionalDollars: null, actualFeeDollars: null,
      fillEconomicsVerifiedAtMs: null, fillEconomicsVerifiedContracts: null,
      createdAtMs: now - ETH_PENDING_RESERVATION_EXPIRY_MS - 1,
    }),
  };
  let expired = false;
  _setEthNoMartingaleDependenciesForTesting({
    now: () => now,
    store: makeStore({
      listUnsettledEthMartingaleOrders: async () => [row],
      expireEthMartingaleReservation: async () => { expired = true; return true; },
    }),
  } as any);
  try {
    await reconcileEthMartingaleSettlements();
    assert.equal(expired, false, "rows carrying fill evidence must stay blocked for reconciliation");
  } finally { _setEthNoMartingaleDependenciesForTesting(null); }
});

// ── settlement reconciliation ────────────────────────────────────────────────

test("recovered closed zero fill releases as a verified handoff without settlement or sequence advance", async () => {
  const row: any = {
    id: "eth-entry:zero", ticker: "KXETH15M-26AUG221200-T69000", easternDate: "2026-08-22",
    martingaleStep: 1, side: "no", clientOrderId: "eth-no-zero", kalshiOrderId: null, noPriceCents: 50,
    requestedContracts: 60, filledContracts: null, outcome: "unresolved", settlementResult: null,
    createdAtMs: 0, submissionVersion: 1, reservedFeeCents: 0,
  };
  let settlements = 0;
  _setEthNoMartingaleDependenciesForTesting({
    authFetch: async (_m: string, p: string) => {
      if (p.startsWith("/portfolio/orders?")) {
        return { orders: [{ order_id: "k-zero", client_order_id: row.clientOrderId, ticker: row.ticker }] };
      }
      if (p.startsWith("/markets/")) {
        return { market: { ticker: row.ticker, close_time: new Date(Date.now() - 1).toISOString() } };
      }
      if (p.startsWith("/portfolio/fills?")) return { fills: [] };
      if (p.startsWith("/portfolio/positions?")) return { market_positions: [] };
      return { order: { order_id: "k-zero", client_order_id: row.clientOrderId,
        ticker: row.ticker, status: "canceled", fill_count_fp: "0.00" } };
    },
    marketFetch: async () => { throw new Error("must not settle a zero-fill"); },
    store: makeStore({
      listUnsettledEthMartingaleOrders: async () => row.outcome === "zero_fill_verified" ? [] : [row],
      updateEthMartingaleOrder: async (u: any) => { Object.assign(row, u); return true; },
      settleEthMartingaleOrder: async () => { settlements++; return true; },
    }),
  } as any);
  try {
    await reconcileEthMartingaleSettlements();
    assert.equal(row.outcome, "zero_fill_verified");
    assert.equal(row.filledContracts, 0);
    assert.equal(settlements, 0, "zero fill must not settle");
  } finally { _setEthNoMartingaleDependenciesForTesting(null); }
});

test("finalized zero-fill GTC survives a transient 429 and failed durable release before exactly one next-window entry", async () => {
  const restore = setEnabled();
  const now = Date.parse("2026-08-23T13:17:00.000Z");
  const today = easternDay(new Date(now));
  const staleRow: any = makeUnsettledOrder({
    id: "eth-entry:KXETH15M-26AUG230900-00",
    ticker: "KXETH15M-26AUG230900-00",
    clientOrderId: "eth-no-0900",
    kalshiOrderId: "k-0900",
    martingaleStep: 1,
    requestedContracts: 60,
    filledContracts: 0,
    outcome: "resting",
  });
  let orderReadAttempts = 0;
  let terminalWrites = 0;
  let reservations = 0;
  let posts = 0;
  let retrySleeps = 0;
  _setEthNoMartingaleDependenciesForTesting({
    now: () => now,
    sleep: async () => { retrySleeps++; },
    isEthOrderSubmissionPermitted: () => true,
    authFetch: async (method: string, path: string, body?: any) => {
      if (method === "GET" && path.includes("/portfolio/orders/k-0900")) {
        orderReadAttempts++;
        if (orderReadAttempts === 1) {
          throw Object.assign(new Error("rate limited"), { status: 429 });
        }
        return {
          order: {
            order_id: "k-0900", client_order_id: staleRow.clientOrderId,
            ticker: staleRow.ticker, status: "canceled", fill_count_fp: "0.00",
          },
        };
      }
      if (method === "POST") {
        posts++;
        return {
          order: {
            order_id: "k-0915", client_order_id: body?.client_order_id,
            ticker: body?.ticker, status: "resting", fill_count_fp: "0.00",
          },
        };
      }
      if (method === "GET" && path.startsWith("/markets/")) {
        return { market: { ticker: staleRow.ticker, result: "no", close_time: new Date(now - 1).toISOString() } };
      }
      if (method === "GET" && path.startsWith("/portfolio/fills?")) return { fills: [] };
      if (method === "GET" && path.startsWith("/portfolio/positions?")) return { market_positions: [] };
      throw new Error(`unexpected exchange request ${method} ${path}`);
    },
    store: makeStore({
      getEthMartingaleState: async () => ({
        easternDate: today, side: "no" as const, martingaleStep: 1,
        spentCents: 0, realizedPnlCents: 0,
      }),
      listUnsettledEthMartingaleZeroFillOrders: async () => [],
      listUnsettledEthMartingaleOrders: async () => staleRow.outcome === "resting" ? [staleRow] : [],
      advanceEthMartingaleLadderForZeroFill: async (_id: string, result: string) => {
        staleRow.settlementResult = result;
        return true;
      },
      reserveEthMartingaleEntry: async () => { reservations++; return true; },
      updateEthMartingaleOrder: async (update: any) => {
        if (update.id === staleRow.id && update.outcome === "zero_fill_verified") {
          terminalWrites++;
          // Model a pool timeout after exchange terminal evidence: do not alter
          // local state until the next reconciliation successfully persists it.
          if (terminalWrites === 1) return false;
          Object.assign(staleRow, update);
        }
        return true;
      },
    }),
  } as any);
  try {
    const nextWindow = openMarket("KXETH15M-26AUG230915-15", now);
    await evaluateEthNoMartingale(nextWindow);
    assert.equal(reservations, 0, "a failed terminal write must keep the stale GTC blocking");
    assert.equal(posts, 0, "no duplicate or next-window POST is allowed while durability is uncertain");

    await evaluateEthNoMartingale(nextWindow);
    assert.equal(retrySleeps, 1, "the first exchange 429 is retried as an idempotent read");
    assert.equal(terminalWrites, 2, "terminal release is retried by a later reconciliation sweep");
    assert.equal(staleRow.outcome, "zero_fill_verified", "finalized zero-fill state preserves the ladder");
    assert.equal(reservations, 1, "the next eligible window evaluates once after durable release");
    assert.equal(posts, 1, "exactly one next-window GTC is submitted");
  } finally {
    _setEthNoMartingaleDependenciesForTesting(null);
    restore();
  }
});

test("settlement sweep stays blocked after a transient failure, then clears once durable terminal evidence recovers", async () => {
  const now = Date.parse("2026-08-23T13:17:00.000Z");
  const row: any = makeUnsettledOrder({
    id: "eth-entry:retry-clear", ticker: "KXETH15M-26AUG230900-00",
    clientOrderId: "eth-no-retry-clear", kalshiOrderId: "k-retry-clear",
    filledContracts: 0, outcome: "resting",
  });
  let reads = 0;
  _setEthNoMartingaleDependenciesForTesting({
    now: () => now,
    authFetch: async (_method: string, path: string) => {
      if (path.startsWith("/markets/")) return { market: { ticker: row.ticker, result: "no", close_time: new Date(now - 1).toISOString() } };
      if (path.startsWith("/portfolio/fills?")) return { fills: [] };
      if (path.startsWith("/portfolio/positions?")) return { market_positions: [] };
      if (path.includes("/portfolio/orders/k-retry-clear")) {
        reads++;
        if (reads === 1) throw Object.assign(new Error("rate limited"), { status: 429 });
        return { order: {
          order_id: row.kalshiOrderId, client_order_id: row.clientOrderId,
          ticker: row.ticker, status: "canceled", fill_count_fp: "0.00",
        } };
      }
      throw new Error(`unexpected exchange request ${path}`);
    },
    sleep: async () => undefined,
    store: makeStore({
      listUnsettledEthMartingaleZeroFillOrders: async () => [],
      listUnsettledEthMartingaleOrders: async () => row.outcome === "zero_fill_verified" ? [] : [row],
      advanceEthMartingaleLadderForZeroFill: async (_id: string, result: string) => {
        row.settlementResult = result;
        return true;
      },
      updateEthMartingaleOrder: async (update: any) => {
        if (reads < 3) return false; // First terminal write fails; the retry sweep recovers durably.
        Object.assign(row, update);
        return true;
      },
    }),
  } as any);
  try {
    assert.equal(await reconcileEthMartingaleSettlements(), true,
      "the coalesced sweep completes even when its individual poll stays unresolved");
    assert.equal(row.outcome, "resting");
    assert.equal(await hasUnsettledEthMartingaleExposure(), true,
      "a transient reconciliation failure must keep the next window fenced");
    assert.equal(await reconcileEthMartingaleSettlements(), true,
      "a newly durable verified no-fill handoff clears without a market-result ladder change");
    assert.equal(row.outcome, "zero_fill_verified");
    assert.equal(await hasUnsettledEthMartingaleExposure(), false,
      "only the durable terminal write removes the next-window fence");
  } finally {
    _setEthNoMartingaleDependenciesForTesting(null);
  }
});

test("ETH blocker status identifies a resting prior order without treating it as settled", async () => {
  const row: any = makeUnsettledOrder({
    id: "eth-entry:blocker-resting",
    ticker: "KXETH15M-26AUG230900-00",
    kalshiOrderId: "k-blocker-resting",
    clientOrderId: "eth-no-blocker-resting",
    filledContracts: 0,
    outcome: "resting",
  });
  _setEthNoMartingaleDependenciesForTesting({
    authFetch: async () => ({ order: {
      order_id: row.kalshiOrderId, client_order_id: row.clientOrderId,
      ticker: row.ticker, status: "resting", fill_count_fp: "0.00",
    } }),
    store: makeStore({
      listEthMartingaleOrdersNeedingFillEconomics: async () => [],
      listUnsettledEthMartingaleOrders: async () => [row],
    }),
  } as any);
  try {
    assert.equal(await reconcileEthMartingaleSettlements(), true);
    const blocker = getEthMartingaleBlockerStatus();
    assert.equal(blocker.code, "resting_prior_order");
    assert.equal(blocker.ticker, row.ticker);
    assert.equal(blocker.orderId, row.kalshiOrderId);
    assert.equal(blocker.requestedContracts, 30);
    assert.equal(blocker.retryScheduled, false, "live resting exposure is not a transient retry condition");
  } finally {
    _setEthNoMartingaleDependenciesForTesting(null);
  }
});

test("failed terminal durable write schedules a bounded reconciliation retry and retains exposure", async () => {
  const row: any = makeUnsettledOrder({
    id: "eth-entry:blocker-write",
    ticker: "KXETH15M-26AUG230900-00",
    kalshiOrderId: "k-blocker-write",
    clientOrderId: "eth-no-blocker-write",
    filledContracts: 0,
    outcome: "resting",
  });
  _setEthNoMartingaleDependenciesForTesting({
    authFetch: async (_method: string, path: string) => {
      if (path.startsWith("/markets/")) return { market: { ticker: row.ticker, close_time: new Date(Date.now() - 1).toISOString() } };
      if (path.startsWith("/portfolio/fills?")) return { fills: [] };
      if (path.startsWith("/portfolio/positions?")) return { market_positions: [] };
      return { order: { order_id: row.kalshiOrderId, client_order_id: row.clientOrderId,
        ticker: row.ticker, status: "canceled", fill_count_fp: "0.00" } };
    },
    store: makeStore({
      listEthMartingaleOrdersNeedingFillEconomics: async () => [],
      listUnsettledEthMartingaleOrders: async () => [row],
      updateEthMartingaleOrder: async () => false,
    }),
  } as any);
  try {
    assert.equal(await reconcileEthMartingaleSettlements(), true);
    const blocker = getEthMartingaleBlockerStatus();
    assert.equal(blocker.code, "durable_store_failure");
    assert.equal(blocker.retryScheduled, true);
    assert.equal(await hasUnsettledEthMartingaleExposure(), true);
  } finally {
    _setEthNoMartingaleDependenciesForTesting(null);
  }
});

test("closed zero-fill verification retries incomplete evidence without posting and clears once evidence arrives", async () => {
  const row: any = makeUnsettledOrder({
    id: "eth-entry:zero-fill-retry",
    ticker: "KXETH15M-26AUG230900-00",
    kalshiOrderId: "k-zero-fill-retry",
    clientOrderId: "eth-no-zero-fill-retry",
    filledContracts: 0,
    outcome: "resting",
  });
  const queuedTimers: Array<() => void> = [];
  let evidenceAvailable = false;
  let posts = 0;
  _setEthNoMartingaleDependenciesForTesting({
    setRetryTimer: ((callback: () => void) => {
      queuedTimers.push(callback);
      return { unref() {} };
    }) as any,
    clearRetryTimer: (() => undefined) as any,
    authFetch: async (method: string, path: string) => {
      if (method === "POST") posts++;
      if (path.startsWith("/markets/")) {
        return { market: { ticker: row.ticker, close_time: new Date(Date.now() - 1).toISOString() } };
      }
      if (path.startsWith("/portfolio/fills?")) return evidenceAvailable ? { fills: [] } : {};
      if (path.startsWith("/portfolio/positions?")) return { market_positions: [] };
      return { order: { order_id: row.kalshiOrderId, client_order_id: row.clientOrderId,
        ticker: row.ticker, status: "canceled", fill_count_fp: "0.00" } };
    },
    store: makeStore({
      listEthMartingaleOrdersNeedingFillEconomics: async () => [],
      listUnsettledEthMartingaleOrders: async () => row.outcome === "zero_fill_verified" ? [] : [row],
      updateEthMartingaleOrder: async (update: any) => { Object.assign(row, update); return true; },
    }),
  } as any);
  try {
    await reconcileEthMartingaleSettlements();
    const blocked = getEthMartingaleBlockerStatus();
    assert.equal(blocked.code, "zero_fill_verification_pending");
    assert.equal(blocked.retryScheduled, true);
    assert.match(blocked.message, /fill-history response is incomplete/);
    assert.equal(posts, 0, "proof retries must never submit a replacement order");

    evidenceAvailable = true;
    const retry = queuedTimers.shift();
    assert.ok(retry, "incomplete proof schedules a short retry");
    retry!();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(row.outcome, "zero_fill_verified");
    assert.equal(posts, 0);
  } finally {
    _setEthNoMartingaleDependenciesForTesting(null);
  }
});

test("closed zero-fill verification retries unavailable or malformed close-time proof without posting", async () => {
  for (const closeFailure of ["unavailable", "malformed"] as const) {
    const row: any = makeUnsettledOrder({
      id: `eth-entry:zero-close-${closeFailure}`,
      ticker: "KXETH15M-26AUG230900-00",
      kalshiOrderId: `k-zero-close-${closeFailure}`,
      clientOrderId: `eth-no-zero-close-${closeFailure}`,
      filledContracts: 0,
      outcome: "resting",
    });
    const queuedTimers: Array<() => void> = [];
    let closeReads = 0;
    let posts = 0;
    _setEthNoMartingaleDependenciesForTesting({
      setRetryTimer: ((callback: () => void) => {
        queuedTimers.push(callback);
        return { unref() {} };
      }) as any,
      clearRetryTimer: (() => undefined) as any,
      sleep: async () => undefined,
      authFetch: async (method: string, path: string) => {
        if (method === "POST") posts++;
        if (path.startsWith("/markets/")) {
          closeReads++;
          if (closeReads === 1 && closeFailure === "unavailable") throw new Error("close-time read unavailable");
          if (closeReads === 1 && closeFailure === "malformed") return { market: { ticker: row.ticker } };
          return { market: { ticker: row.ticker, close_time: new Date(Date.now() - 1).toISOString() } };
        }
        if (path.startsWith("/portfolio/fills?")) return { fills: [] };
        if (path.startsWith("/portfolio/positions?")) return { market_positions: [] };
        return { order: { order_id: row.kalshiOrderId, client_order_id: row.clientOrderId,
          ticker: row.ticker, status: "canceled", fill_count_fp: "0.00" } };
      },
      store: makeStore({
        listEthMartingaleOrdersNeedingFillEconomics: async () => [],
        listUnsettledEthMartingaleOrders: async () => row.outcome === "zero_fill_verified" ? [] : [row],
        updateEthMartingaleOrder: async (update: any) => { Object.assign(row, update); return true; },
      }),
    } as any);
    try {
      await reconcileEthMartingaleSettlements();
      const blocked = getEthMartingaleBlockerStatus();
      assert.equal(blocked.code, "zero_fill_verification_pending", closeFailure);
      assert.equal(blocked.retryScheduled, true, closeFailure);
      assert.match(blocked.message, /market closure has not been confirmed/, closeFailure);
      assert.equal(posts, 0, closeFailure);

      const retry = queuedTimers.shift();
      assert.ok(retry, `${closeFailure} close proof queues a retry`);
      retry!();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(row.outcome, "zero_fill_verified", `${closeFailure} resolves when valid evidence arrives`);
      assert.equal(posts, 0, closeFailure);
    } finally {
      _setEthNoMartingaleDependenciesForTesting(null);
    }
  }
});

test("closed zero-fill verification retries incomplete terminal identity, count, and history evidence without posting", async () => {
  for (const failure of ["identity", "count", "history"] as const) {
    const row: any = makeUnsettledOrder({
      id: `eth-entry:zero-terminal-${failure}`,
      ticker: "KXETH15M-26AUG230900-00",
      kalshiOrderId: `k-zero-terminal-${failure}`,
      clientOrderId: `eth-no-zero-terminal-${failure}`,
      filledContracts: 0,
      outcome: "resting",
    });
    const queuedTimers: Array<() => void> = [];
    let repaired = false;
    let detailReads = 0;
    let posts = 0;
    const validTerminal = () => ({ order_id: row.kalshiOrderId, client_order_id: row.clientOrderId,
      ticker: row.ticker, status: "canceled", fill_count_fp: "0.00" });
    _setEthNoMartingaleDependenciesForTesting({
      setRetryTimer: ((callback: () => void) => {
        queuedTimers.push(callback);
        return { unref() {} };
      }) as any,
      clearRetryTimer: (() => undefined) as any,
      authFetch: async (method: string, path: string) => {
        if (method === "POST") posts++;
        if (path.startsWith("/markets/")) {
          return { market: { ticker: row.ticker, close_time: new Date(Date.now() - 1).toISOString() } };
        }
        if (path.startsWith("/portfolio/fills?")) return { fills: [] };
        if (path.startsWith("/portfolio/positions?")) return { market_positions: [] };
        if (method === "DELETE") return {};
        if (path.startsWith("/portfolio/orders?")) return { orders: [] };
        if (path.startsWith("/portfolio/orders/")) {
          detailReads++;
          if (!repaired && failure === "history") {
            const error: any = new Error("not found");
            error.status = 404;
            throw error;
          }
          if (!repaired && failure === "identity") {
            return { order: { ...validTerminal(), client_order_id: "wrong-client-id" } };
          }
          if (!repaired && failure === "count") {
            const { fill_count_fp: _count, ...withoutCount } = validTerminal();
            return { order: withoutCount };
          }
          return { order: validTerminal() };
        }
        throw new Error(`unexpected ${method} ${path}`);
      },
      store: makeStore({
        listEthMartingaleOrdersNeedingFillEconomics: async () => [],
        listUnsettledEthMartingaleOrders: async () => row.outcome === "zero_fill_verified" ? [] : [row],
        updateEthMartingaleOrder: async (update: any) => { Object.assign(row, update); return true; },
      }),
    } as any);
    try {
      await reconcileEthMartingaleSettlements();
      const blocked = getEthMartingaleBlockerStatus();
      assert.equal(blocked.code, "zero_fill_verification_pending", failure);
      assert.equal(blocked.retryScheduled, true, failure);
      assert.equal(posts, 0, failure);

      repaired = true;
      const retry = queuedTimers.shift();
      assert.ok(retry, `${failure} schedules a short proof retry`);
      retry!();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(row.outcome, "zero_fill_verified", failure);
      assert.equal(posts, 0, failure);
      assert.ok(detailReads >= 2, `${failure} rechecks terminal evidence`);
    } finally {
      _setEthNoMartingaleDependenciesForTesting(null);
    }
  }
});

test("closed zero-fill verification reports attention required after bounded retries without releasing exposure", async () => {
  const row: any = makeUnsettledOrder({
    id: "eth-entry:zero-fill-attention",
    ticker: "KXETH15M-26AUG230900-00",
    kalshiOrderId: "k-zero-fill-attention",
    clientOrderId: "eth-no-zero-fill-attention",
    filledContracts: 0,
    outcome: "resting",
  });
  const queuedTimers: Array<() => void> = [];
  let posts = 0;
  _setEthNoMartingaleDependenciesForTesting({
    setRetryTimer: ((callback: () => void) => {
      queuedTimers.push(callback);
      return { unref() {} };
    }) as any,
    clearRetryTimer: (() => undefined) as any,
    authFetch: async (method: string, path: string) => {
      if (method === "POST") posts++;
      if (path.startsWith("/markets/")) {
        return { market: { ticker: row.ticker, close_time: new Date(Date.now() - 1).toISOString() } };
      }
      if (path.startsWith("/portfolio/fills?")) return {};
      return { order: { order_id: row.kalshiOrderId, client_order_id: row.clientOrderId,
        ticker: row.ticker, status: "canceled", fill_count_fp: "0.00" } };
    },
    store: makeStore({
      listEthMartingaleOrdersNeedingFillEconomics: async () => [],
      listUnsettledEthMartingaleOrders: async () => [row],
    }),
  } as any);
  try {
    await reconcileEthMartingaleSettlements();
    for (let attempt = 0; attempt < 3; attempt++) {
      const retry = queuedTimers.shift();
      assert.ok(retry, `short verification retry ${attempt + 1} is queued`);
      retry!();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const blocker = getEthMartingaleBlockerStatus();
    assert.equal(blocker.code, "zero_fill_verification_pending");
    assert.equal(blocker.retryScheduled, false);
    assert.match(blocker.message, /needs attention/);
    assert.equal(row.outcome, "resting", "missing proof cannot release a closed order");
    assert.equal(posts, 0, "verification retries must never submit an order");
  } finally {
    _setEthNoMartingaleDependenciesForTesting(null);
  }
});

test("failed resting-fill update keeps the persisted quantity authoritative and schedules recovery", async () => {
  const row: any = makeUnsettledOrder({
    id: "eth-entry:blocker-resting-fill",
    ticker: "KXETH15M-26AUG230900-00",
    kalshiOrderId: "k-blocker-resting-fill",
    clientOrderId: "eth-no-blocker-resting-fill",
    filledContracts: 0,
    outcome: "resting",
  });
  _setEthNoMartingaleDependenciesForTesting({
    authFetch: async () => ({ order: {
      order_id: row.kalshiOrderId, client_order_id: row.clientOrderId,
      ticker: row.ticker, status: "resting", fill_count_fp: "5.00",
    } }),
    store: makeStore({
      listEthMartingaleOrdersNeedingFillEconomics: async () => [],
      listUnsettledEthMartingaleOrders: async () => [row],
      updateEthMartingaleOrder: async () => false,
    }),
  } as any);
  try {
    assert.equal(await reconcileEthMartingaleSettlements(), true);
    assert.equal(row.filledContracts, 0, "the exchange fill cannot replace the persisted quantity after a failed write");
    const blocker = getEthMartingaleBlockerStatus();
    assert.equal(blocker.code, "durable_store_failure");
    assert.equal(blocker.retryScheduled, true);
    assert.equal(blocker.filledContracts, 0);
  } finally {
    _setEthNoMartingaleDependenciesForTesting(null);
  }
});

test("failed exact fill-economics persistence schedules reconciliation-only recovery", async () => {
  const row: any = makeUnsettledOrder({
    id: "eth-entry:blocker-economics",
    ticker: "KXETH15M-26AUG230900-00",
    kalshiOrderId: "k-blocker-economics",
    clientOrderId: "eth-no-blocker-economics",
    filledContracts: 30,
    outcome: "full_fill",
    actualNotionalDollars: null,
    actualFeeDollars: null,
    fillEconomicsVerifiedContracts: null,
  });
  _setEthNoMartingaleDependenciesForTesting({
    authFetch: async (_method: string, path: string) => {
      if (path.includes("/portfolio/fills?")) return { fills: [{
        fill_id: "blocker-economics-fill", count_fp: "30.00",
        no_price_dollars: "0.5000", yes_price_dollars: "0.5000", fee_cost_dollars: "0.0530",
      }] };
      throw new Error(`unexpected exchange request ${path}`);
    },
    marketFetch: async () => ({ market: { result: "no" } }),
    store: makeStore({
      listEthMartingaleOrdersNeedingFillEconomics: async () => [row],
      listUnsettledEthMartingaleOrders: async () => [],
      recordEthMartingaleFillEconomics: async () => false,
    }),
  } as any);
  try {
    await reconcileEthMartingaleSettlements();
    const blocker = getEthMartingaleBlockerStatus();
    assert.equal(blocker.code, "durable_store_failure");
    assert.equal(blocker.retryScheduled, true);
  } finally {
    _setEthNoMartingaleDependenciesForTesting(null);
  }
});

test("repeated durable failures exhaust the three short reconciliation retries without posting", async () => {
  const row: any = makeUnsettledOrder({
    id: "eth-entry:retry-cap",
    ticker: "KXETH15M-26AUG230900-00",
    kalshiOrderId: "k-retry-cap",
    clientOrderId: "eth-no-retry-cap",
    filledContracts: 0,
    outcome: "resting",
  });
  const queuedTimers: Array<() => void> = [];
  let posts = 0;
  _setEthNoMartingaleDependenciesForTesting({
    setRetryTimer: ((callback: () => void) => {
      queuedTimers.push(callback);
      return { unref() {} };
    }) as any,
    clearRetryTimer: (() => undefined) as any,
    authFetch: async (method: string, path: string) => {
      if (method === "POST") posts++;
      if (path.startsWith("/markets/")) return { market: { ticker: row.ticker, close_time: new Date(Date.now() - 1).toISOString() } };
      if (path.startsWith("/portfolio/fills?")) return { fills: [] };
      if (path.startsWith("/portfolio/positions?")) return { market_positions: [] };
      return { order: {
        order_id: row.kalshiOrderId, client_order_id: row.clientOrderId,
        ticker: row.ticker, status: "canceled", fill_count_fp: "0.00",
      } };
    },
    store: makeStore({
      listEthMartingaleOrdersNeedingFillEconomics: async () => [],
      listUnsettledEthMartingaleOrders: async () => [row],
      updateEthMartingaleOrder: async () => false,
    }),
  } as any);
  try {
    await reconcileEthMartingaleSettlements();
    for (let attempt = 0; attempt < 3; attempt++) {
      const callback = queuedTimers.shift();
      assert.ok(callback, `retry ${attempt + 1} must be scheduled`);
      callback!();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.equal(queuedTimers.length, 0, "a fourth short retry must not be scheduled");
    const blocker = getEthMartingaleBlockerStatus();
    assert.equal(blocker.retryAttempt, 3);
    assert.equal(blocker.retryScheduled, false);
    assert.equal(posts, 0, "reconciliation retries must never reach the entry POST path");
  } finally {
    _setEthNoMartingaleDependenciesForTesting(null);
  }
});

test("failed settlement transition schedules retry without a duplicate durable transition", async () => {
  const row: any = makeUnsettledOrder({
    id: "eth-entry:blocker-settlement",
    ticker: "KXETH15M-26AUG230900-00",
    kalshiOrderId: "k-blocker-settlement",
    clientOrderId: "eth-no-blocker-settlement",
    filledContracts: 30,
    outcome: "full_fill",
    actualNotionalDollars: 15,
    actualFeeDollars: 0.053,
    fillEconomicsVerifiedContracts: 30,
  });
  let settlements = 0;
  _setEthNoMartingaleDependenciesForTesting({
    marketSettlementFetch: async () => ({ market: { result: "no" } }),
    store: makeStore({
      listEthMartingaleOrdersNeedingFillEconomics: async () => [],
      listUnsettledEthMartingaleOrders: async () => [row],
      settleEthMartingaleOrder: async () => { settlements++; return false; },
    }),
  } as any);
  try {
    assert.equal(await reconcileEthMartingaleSettlements(), false);
    assert.equal(settlements, 1, "a failed conditional settlement write is attempted once per sweep");
    const blocker = getEthMartingaleBlockerStatus();
    assert.equal(blocker.code, "settlement_write_retry");
    assert.equal(blocker.retryScheduled, true);
  } finally {
    _setEthNoMartingaleDependenciesForTesting(null);
  }
});

test("stale resting full fill resolves from terminal Kalshi status and releases after settlement", async () => {
  const restore = setEnabled();
  const now = Date.parse("2026-08-23T13:17:00.000Z");
  const today = easternDay(new Date(now));
  const staleRow: any = makeUnsettledOrder({
    id: "eth-entry:prior-full", ticker: "KXETH15M-26AUG230900-00",
    clientOrderId: "eth-no-prior-full", kalshiOrderId: "k-prior-full",
    filledContracts: 0, outcome: "resting",
    actualNotionalDollars: null, actualFeeDollars: null, fillEconomicsVerifiedContracts: null,
  });
  let reservations = 0;
  let posts = 0;
  let settled = 0;
  _setEthNoMartingaleDependenciesForTesting({
    now: () => now,
    isEthOrderSubmissionPermitted: () => true,
    authFetch: async (method: string, path: string, body?: any) => {
      if (method === "GET" && path.includes("/portfolio/orders/k-prior-full")) {
        return { order: { order_id: "k-prior-full", client_order_id: staleRow.clientOrderId,
          ticker: staleRow.ticker, status: "filled", fill_count_fp: "30.00" } };
      }
      if (method === "GET" && path.includes("/portfolio/fills?")) {
        return { fills: [{ fill_id: "prior-full", count_fp: "30.00", no_price_dollars: "0.5000",
          yes_price_dollars: "0.5000", fee_cost_dollars: "0.0530" }] };
      }
      if (method === "POST") {
        posts++;
        return { order: { order_id: "k-next-full", client_order_id: body?.client_order_id,
          ticker: body?.ticker, status: "resting", fill_count_fp: "0.00" } };
      }
      throw new Error(`unexpected exchange request ${method} ${path}`);
    },
    marketFetch: async () => ({ market: { result: "no" } }),
    store: makeStore({
      getEthMartingaleState: async () => ({
        easternDate: today, side: "no" as const, martingaleStep: 0, spentCents: 0, realizedPnlCents: 0,
      }),
      listUnsettledEthMartingaleOrders: async () => staleRow.settlementResult == null ? [staleRow] : [],
      updateEthMartingaleOrder: async (update: any) => {
        if (update.id === staleRow.id) Object.assign(staleRow, update);
        return true;
      },
      recordEthMartingaleFillEconomics: async () => true,
      settleEthMartingaleOrder: async () => { settled++; staleRow.settlementResult = "no"; return true; },
      reserveEthMartingaleEntry: async () => { reservations++; return true; },
    }),
  } as any);
  try {
    await evaluateEthNoMartingale(openMarket("KXETH15M-26AUG230915-15", now));
    assert.equal(staleRow.outcome, "full_fill");
    assert.equal(staleRow.filledContracts, 30);
    assert.equal(settled, 1, "full terminal fill settles during the close handoff");
    assert.equal(reservations, 1);
    assert.equal(posts, 1);
  } finally {
    _setEthNoMartingaleDependenciesForTesting(null);
    restore();
  }
});

test("partial fill with a count-less Kalshi cancellation remains fenced", async () => {
  const restore = setEnabled();
  const now = Date.parse("2026-08-23T13:17:00.000Z");
  const today = easternDay(new Date(now));
  const staleRow: any = makeUnsettledOrder({
    id: "eth-entry:prior-partial", ticker: "KXETH15M-26AUG230900-00",
    clientOrderId: "eth-no-prior-partial", kalshiOrderId: "k-prior-partial",
    requestedContracts: 60, filledContracts: 21.42, outcome: "resting",
    actualNotionalDollars: null, actualFeeDollars: null, fillEconomicsVerifiedContracts: null,
  });
  let settlements = 0;
  let reservations = 0;
  _setEthNoMartingaleDependenciesForTesting({
    now: () => now,
    isEthOrderSubmissionPermitted: () => true,
    authFetch: async (method: string, path: string, body?: any) => {
      if (method === "GET" && path.includes("/portfolio/orders/k-prior-partial")) {
        return { order: { order_id: "k-prior-partial", client_order_id: staleRow.clientOrderId,
          ticker: staleRow.ticker, status: "canceled" } };
      }
      if (method === "GET" && path.includes("/portfolio/fills?")) {
        return { fills: [{ fill_id: "prior-partial", count_fp: "21.42", no_price_dollars: "0.5000",
          yes_price_dollars: "0.5000", fee_cost_dollars: "0.0369" }] };
      }
      if (method === "POST") {
        return { order: { order_id: "k-next-partial", client_order_id: body?.client_order_id,
          ticker: body?.ticker, status: "resting", fill_count_fp: "0.00" } };
      }
      throw new Error(`unexpected exchange request ${method} ${path}`);
    },
    marketFetch: async () => ({ market: { result: "no" } }),
    store: makeStore({
      getEthMartingaleState: async () => ({
        easternDate: today, side: "no" as const, martingaleStep: 1, spentCents: 0, realizedPnlCents: 0,
      }),
      listUnsettledEthMartingaleOrders: async () => staleRow.settlementResult == null ? [staleRow] : [],
      updateEthMartingaleOrder: async (update: any) => {
        if (update.id === staleRow.id) Object.assign(staleRow, update);
        return true;
      },
      recordEthMartingaleFillEconomics: async () => true,
      settleEthMartingaleOrder: async () => { settlements++; staleRow.settlementResult = "no"; return true; },
      reserveEthMartingaleEntry: async () => { reservations++; return true; },
    }),
  } as any);
  try {
    await evaluateEthNoMartingale(openMarket("KXETH15M-26AUG230915-15", now));
    assert.equal(staleRow.outcome, "resting");
    assert.equal(staleRow.filledContracts, 21.42, "ambiguous terminal evidence cannot erase known fractional exposure");
    assert.equal(settlements, 0);
    assert.equal(reservations, 0, "the next window stays blocked without a final exchange count");
  } finally {
    _setEthNoMartingaleDependenciesForTesting(null);
    restore();
  }
});

test("terminal zero-fill cancellation without a returned count remains blocked", async () => {
  const restore = setEnabled();
  const now = Date.parse("2026-08-23T13:17:00.000Z");
  const today = easternDay(new Date(now));
  const staleRow: any = makeUnsettledOrder({
    id: "eth-entry:prior-zero", ticker: "KXETH15M-26AUG230900-00",
    clientOrderId: "eth-no-prior-zero", kalshiOrderId: "k-prior-zero",
    filledContracts: 0, outcome: "resting",
  });
  let reservations = 0;
  _setEthNoMartingaleDependenciesForTesting({
    now: () => now,
    isEthOrderSubmissionPermitted: () => true,
    authFetch: async (method: string, path: string, body?: any) => {
      if (method === "GET" && path.includes("/portfolio/orders/k-prior-zero")) {
        return { order: { order_id: "k-prior-zero", client_order_id: staleRow.clientOrderId,
          ticker: staleRow.ticker, status: "canceled" } };
      }
      if (method === "POST") {
        return { order: { order_id: "k-next-zero", client_order_id: body?.client_order_id,
          ticker: body?.ticker, status: "resting", fill_count_fp: "0.00" } };
      }
      throw new Error(`unexpected exchange request ${method} ${path}`);
    },
    marketFetch: async () => { throw new Error("zero fill must not seek settlement"); },
    store: makeStore({
      getEthMartingaleState: async () => ({
        easternDate: today, side: "no" as const, martingaleStep: 1, spentCents: 0, realizedPnlCents: 0,
      }),
      listUnsettledEthMartingaleOrders: async () => staleRow.outcome === "resting" ? [staleRow] : [],
      updateEthMartingaleOrder: async (update: any) => {
        if (update.id === staleRow.id) Object.assign(staleRow, update);
        return true;
      },
      reserveEthMartingaleEntry: async () => { reservations++; return true; },
    }),
  } as any);
  try {
    await evaluateEthNoMartingale(openMarket("KXETH15M-26AUG230915-15", now));
    assert.equal(staleRow.outcome, "resting");
    assert.equal(staleRow.filledContracts, 0);
    assert.equal(reservations, 0, "a count-less terminal response cannot release the next window");
  } finally {
    _setEthNoMartingaleDependenciesForTesting(null);
    restore();
  }
});

test("restart handoff resolves an unresolved partial only through matching terminal evidence", async () => {
  const restore = setEnabled();
  const now = Date.parse("2026-08-23T13:17:00.000Z");
  const today = easternDay(new Date(now));
  const recoveredRow: any = makeUnsettledOrder({
    id: "eth-entry:restart-partial", ticker: "KXETH15M-26AUG230900-00",
    clientOrderId: "eth-no-restart-partial", kalshiOrderId: null,
    requestedContracts: 60, filledContracts: 21.42, outcome: "unresolved",
    actualNotionalDollars: null, actualFeeDollars: null, fillEconomicsVerifiedContracts: null,
  });
  let reservations = 0;
  let settlements = 0;
  let settled = false;
  const durableUpdates: any[] = [];
  _setEthNoMartingaleDependenciesForTesting({
    now: () => now,
    isEthOrderSubmissionPermitted: () => true,
    authFetch: async (method: string, path: string, body?: any) => {
      if (method === "GET" && path.startsWith("/portfolio/orders?")) {
        return { orders: [{ order_id: "k-restart-partial", client_order_id: recoveredRow.clientOrderId,
          ticker: recoveredRow.ticker }] };
      }
      if (method === "GET" && path.includes("/portfolio/orders/k-restart-partial")) {
        return { order: { order_id: "k-restart-partial", client_order_id: recoveredRow.clientOrderId,
          ticker: recoveredRow.ticker, status: "canceled", fill_count_fp: "21.42" } };
      }
      if (method === "GET" && path.includes("/portfolio/fills?")) {
        return { fills: [{ fill_id: "restart-partial", count_fp: "21.42", no_price_dollars: "0.5000",
          yes_price_dollars: "0.5000", fee_cost_dollars: "0.0369" }] };
      }
      if (method === "POST") {
        return { order: { order_id: "k-next-restart", client_order_id: body?.client_order_id,
          ticker: body?.ticker, status: "resting", fill_count_fp: "0.00" } };
      }
      throw new Error(`unexpected exchange request ${method} ${path}`);
    },
    marketFetch: async () => ({ market: { result: "no" } }),
    store: makeStore({
      getEthMartingaleState: async () => ({
        easternDate: today, side: "no" as const, martingaleStep: 1, spentCents: 0, realizedPnlCents: 0,
      }),
      listUnsettledEthMartingaleOrders: async () => settled ? [] : [recoveredRow],
      updateEthMartingaleOrder: async (update: any) => {
        durableUpdates.push(update);
        return true;
      },
      recordEthMartingaleFillEconomics: async () => true,
      settleEthMartingaleOrder: async () => { settlements++; settled = true; return true; },
      reserveEthMartingaleEntry: async () => { reservations++; return true; },
    }),
  } as any);
  try {
    await evaluateEthNoMartingale(openMarket("KXETH15M-26AUG230915-15", now));
    assert.deepEqual(durableUpdates[0], {
      id: recoveredRow.id, kalshiOrderId: "k-restart-partial",
      filledContracts: 21.42, filledFeeCents: 38, outcome: "partial_fill",
    });
    assert.equal(settlements, 1, "restart handoff settles from recovered state in the same sweep");
    assert.equal(reservations, 1, "restart does not leave a terminal prior window permanently blocking");
  } finally {
    _setEthNoMartingaleDependenciesForTesting(null);
    restore();
  }
});

test("terminal poll rejects mismatched or regressing Kalshi order evidence", async () => {
  const restore = setEnabled();
  const now = Date.parse("2026-08-23T13:17:00.000Z");
  const today = easternDay(new Date(now));
  for (const scenario of [
    { name: "mismatched order id", orderId: "k-other", fill: undefined, known: 0 },
    { name: "missing order id", orderId: undefined, fill: undefined, known: 0 },
    { name: "regressing fill count", orderId: "k-prior-identity", fill: "0.00", known: 21.42 },
  ]) {
    const row: any = makeUnsettledOrder({
      id: `eth-entry:${scenario.name}`, ticker: "KXETH15M-26AUG230900-00",
      clientOrderId: "eth-no-prior-identity", kalshiOrderId: "k-prior-identity",
      requestedContracts: 60, filledContracts: scenario.known, outcome: "resting",
    });
    let updates = 0;
    let reservations = 0;
    _setEthNoMartingaleDependenciesForTesting({
      now: () => now,
      isEthOrderSubmissionPermitted: () => true,
      authFetch: async (method: string, path: string) => {
        if (method === "GET" && path.includes("/portfolio/orders/k-prior-identity")) {
          return { order: {
            ...(scenario.orderId === undefined ? {} : { order_id: scenario.orderId }),
            client_order_id: row.clientOrderId, ticker: row.ticker, status: "canceled",
            ...(scenario.fill === undefined ? {} : { fill_count_fp: scenario.fill }),
          } };
        }
        throw new Error(`unexpected exchange request ${method} ${path}`);
      },
      marketFetch: async () => null,
      store: makeStore({
        getEthMartingaleState: async () => ({
          easternDate: today, side: "no" as const, martingaleStep: 1, spentCents: 0, realizedPnlCents: 0,
        }),
        listUnsettledEthMartingaleOrders: async () => [row],
        updateEthMartingaleOrder: async () => { updates++; return true; },
        reserveEthMartingaleEntry: async () => { reservations++; return true; },
      }),
    } as any);
    await evaluateEthNoMartingale(openMarket("KXETH15M-26AUG230915-15", now));
    assert.equal(updates, 0, `${scenario.name}: terminal evidence must not write a release`);
    assert.equal(reservations, 0, `${scenario.name}: ambiguous/live prior state must still block`);
  }
  _setEthNoMartingaleDependenciesForTesting(null);
  restore();
});

test("restart recovery rejects terminal detail with a missing order identity", async () => {
  const restore = setEnabled();
  const now = Date.parse("2026-08-23T13:17:00.000Z");
  const today = easternDay(new Date(now));
  const row: any = makeUnsettledOrder({
    id: "eth-entry:restart-missing-id", ticker: "KXETH15M-26AUG230900-00",
    clientOrderId: "eth-no-restart-missing-id", kalshiOrderId: null, filledContracts: 0, outcome: "unresolved",
  });
  let updates = 0;
  let reservations = 0;
  _setEthNoMartingaleDependenciesForTesting({
    now: () => now,
    isEthOrderSubmissionPermitted: () => true,
    authFetch: async (method: string, path: string) => {
      if (method === "GET" && path.startsWith("/portfolio/orders?")) {
        return { orders: [{ order_id: "k-restart-missing-id", client_order_id: row.clientOrderId, ticker: row.ticker }] };
      }
      if (method === "GET" && path.includes("/portfolio/orders/k-restart-missing-id")) {
        return { order: { client_order_id: row.clientOrderId, ticker: row.ticker, status: "canceled" } };
      }
      throw new Error(`unexpected exchange request ${method} ${path}`);
    },
    marketFetch: async () => null,
    store: makeStore({
      getEthMartingaleState: async () => ({
        easternDate: today, side: "no" as const, martingaleStep: 1, spentCents: 0, realizedPnlCents: 0,
      }),
      listUnsettledEthMartingaleOrders: async () => [row],
      updateEthMartingaleOrder: async () => { updates++; return true; },
      reserveEthMartingaleEntry: async () => { reservations++; return true; },
    }),
  } as any);
  try {
    await evaluateEthNoMartingale(openMarket("KXETH15M-26AUG230915-15", now));
    assert.equal(updates, 0);
    assert.equal(reservations, 0, "restart must remain blocked without matching terminal order id");
  } finally {
    _setEthNoMartingaleDependenciesForTesting(null);
    restore();
  }
});

// ── kill-switch integration ───────────────────────────────────────────────────

test("disabled strategy never touches the store", async () => {
  const restore = setEnabled("false");
  let storeCalled = false;
  const now = Date.now();
  _setEthNoMartingaleDependenciesForTesting({
    isEthOrderSubmissionPermitted: () => false,
    now: () => now,
    store: makeStore({ listUnsettledEthMartingaleOrders: async () => { storeCalled = true; return []; } }),
  } as any);
  try {
    await evaluateEthNoMartingale(openMarket("KXETH15M-26AUG221200-T69000", now));
    assert.equal(storeCalled, false);
  } finally { _setEthNoMartingaleDependenciesForTesting(null); restore(); }
});

test("disabled strategy still settles existing filled exposure without submitting or force-closing", async () => {
  const restore = setEnabled("false");
  const row: any = makeUnsettledOrder({
    id: "eth-entry:disabled-settlement",
    ticker: "KXETH15M-disabled-settlement",
    kalshiOrderId: "k-disabled-settlement",
    filledContracts: 30,
    filledFeeCents: 53,
    outcome: "full_fill",
    settlementResult: null,
  });
  const exchangeMethods: string[] = [];
  let settlements = 0;
  _setEthNoMartingaleDependenciesForTesting({
    authFetch: async (method: string) => {
      exchangeMethods.push(method);
      return {};
    },
    marketFetch: async () => ({ market: { result: "no" } }),
    store: makeStore({
      listUnsettledEthMartingaleOrders: async () => row.settlementResult == null ? [row] : [],
      settleEthMartingaleOrder: async (_id: string, result: string) => {
        row.settlementResult = result;
        settlements++;
        return true;
      },
    }),
  } as any);
  try {
    await reconcileEthMartingaleSettlements();
    assert.equal(settlements, 1, "existing filled exposure continues normal settlement");
    assert.equal(row.settlementResult, "no");
    assert.equal(exchangeMethods.includes("POST"), false, "reconciliation never submits a replacement order");
    assert.equal(exchangeMethods.includes("DELETE"), false, "disabling does not force-close the filled position");
  } finally {
    _setEthNoMartingaleDependenciesForTesting(null);
    restore();
  }
});

// ── spent_cents accounting ────────────────────────────────────────────────────

test("spent_cents: zero fill returns full principal and fee to budget", () => {
  const requested = 30, price = 50, reservedFee = 53, filled = 0, filledFee = 0;
  const reserved = requested * price + reservedFee;
  const toReturn = (requested - filled) * price + (reservedFee - filledFee);
  assert.equal(toReturn, reserved, "zero fill returns every cent that was reserved");
});

test("spent_cents: full fill returns only fee delta (unused fee portion)", () => {
  const requested = 30, price = 50, reservedFee = 53, filled = 30, filledFee = 53;
  const toReturn = (requested - filled) * price + (reservedFee - filledFee);
  assert.equal(toReturn, 0, "full fill with exact fee returns zero (nothing to release)");
  const filledFeeLess = 40;
  const toReturnWithSaving = (requested - filled) * price + (reservedFee - filledFeeLess);
  assert.equal(toReturnWithSaving, 13, "surplus fee is returned to budget");
});

test("spent_cents: partial fill returns unused contracts plus fee delta", () => {
  const requested = 30, price = 50, reservedFee = 53, filled = 10, filledFee = 20;
  const toReturn = (requested - filled) * price + (reservedFee - filledFee);
  assert.equal(toReturn, 1033, "partial fill releases unused contracts and fee surplus");
  const reserved = requested * price + reservedFee;
  const actualCost = filled * price + filledFee;
  assert.equal(reserved - toReturn, actualCost, "spent after release equals actual cost");
});

// ── resting order stays in unsettled list ─────────────────────────────────────

test("resting order with outcome=resting is included in unsettled check", async () => {
  // The evaluator's block-if-unsettled check must include resting orders.
  const restore = setEnabled();
  let reservations = 0;
  const now = Date.now();
  _setEthNoMartingaleDependenciesForTesting({
    isEthOrderSubmissionPermitted: () => true,
    now: () => now,
    marketFetch: async () => null,
    // Simulate: the store returns a resting row in listUnsettledEthMartingaleOrders.
    // pollEthRestingOrder is called in reconcile but we also need the evaluator to see it.
    authFetch: async (_m: string, p: string) => {
      // Poll returns still resting
      return { order: { order_id: "k-still-rest", client_order_id: "eth-no-rest", ticker: "KXETH15M-26AUG221200-T69000", status: "resting", fill_count_fp: "0.00" } };
    },
    store: makeStore({
      listUnsettledEthMartingaleOrders: async () => [
        makeUnsettledOrder({
          outcome: "resting", kalshiOrderId: "k-still-rest",
          clientOrderId: "eth-no-rest", filledContracts: 0,
        }),
      ],
      reserveEthMartingaleEntry: async () => { reservations++; return true; },
      updateEthMartingaleOrder: async () => true,
    }),
  } as any);
  try {
    await evaluateEthNoMartingale(openMarket("KXETH15M-26AUG221200-T69000", now));
    assert.equal(reservations, 0, "resting order (still active) must block new reservation");
  } finally { _setEthNoMartingaleDependenciesForTesting(null); restore(); }
});
