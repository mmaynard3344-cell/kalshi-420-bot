import assert from "node:assert/strict";
import test from "node:test";
import {
  ETH420_SECONDARY_ENTRY_MAX_TIMER_LATENESS_MS, ETH420_SECONDARY_ENTRY_OFFSET_MS,
  assessEth420SecondaryGlobalActivation, evaluateEth420SecondaryEntry, evaluateEth420SecondaryActivationReadiness, isEth420SecondaryDecisionOnTime, isEth420SecondaryEntryPermitted,
  tryEth420SecondaryEntry,
} from "./eth420SecondaryEntry.js";

test("secondary rule is disabled by default and rejects weakening, expensive, or filled primaries", () => {
  const live = process.env["ETH_420_CANDIDATE_LIVE_ENABLED"], secondary = process.env["ETH_420_CANDIDATE_SECONDARY_CROSS_ENABLED"];
  try {
    delete process.env["ETH_420_CANDIDATE_LIVE_ENABLED"]; delete process.env["ETH_420_CANDIDATE_SECONDARY_CROSS_ENABLED"];
    assert.equal(isEth420SecondaryEntryPermitted(), false);
    assert.deepEqual(evaluateEth420SecondaryEntry({ reservationAskCents: 55, currentAskCents: 55, primaryLimitPriceCents: 50, primaryFilledContracts: 0 }), { eligible: true, crossPriceCents: 55 });
    assert.equal(evaluateEth420SecondaryEntry({ reservationAskCents: 55, currentAskCents: 54, primaryLimitPriceCents: 50, primaryFilledContracts: 0 }).eligible, false);
    assert.equal(evaluateEth420SecondaryEntry({ reservationAskCents: 55, currentAskCents: 66, primaryLimitPriceCents: 50, primaryFilledContracts: 0 }).eligible, false);
    assert.equal(evaluateEth420SecondaryEntry({ reservationAskCents: 55, currentAskCents: 55, primaryLimitPriceCents: 50, primaryFilledContracts: 1 }).eligible, false);
  } finally {
    if (live == null) delete process.env["ETH_420_CANDIDATE_LIVE_ENABLED"]; else process.env["ETH_420_CANDIDATE_LIVE_ENABLED"] = live;
    if (secondary == null) delete process.env["ETH_420_CANDIDATE_SECONDARY_CROSS_ENABLED"]; else process.env["ETH_420_CANDIDATE_SECONDARY_CROSS_ENABLED"] = secondary;
  }
});

test("activation readiness accepts only an ordinary zero-fill resting primary with exact exchange proof", () => {
  const primary = {
    id: "primary-id", ticker: "KXETH15M-test", createdAtMs: 0, kalshiOrderId: "primary-order",
    originalPrimaryKalshiOrderId: "primary-order", status: "submitted", filledContracts: null,
    settlementResult: null, lastRecoveryOutcome: null,
  };
  const resting = {
    orderId: "primary-order", clientOrderId: "primary-id", ticker: "KXETH15M-test",
    status: "resting", filledContracts: 0,
  };
  assert.deepEqual(evaluateEth420SecondaryActivationReadiness(primary, resting), { ready: true });
  assert.deepEqual(evaluateEth420SecondaryActivationReadiness(primary, { ...resting, filledContracts: null }),
    { ready: false, reason: "exchange_fill_uncertain" });
  assert.deepEqual(evaluateEth420SecondaryActivationReadiness(primary, { ...resting, filledContracts: 1 }),
    { ready: false, reason: "exchange_fill_nonzero" });
  assert.deepEqual(evaluateEth420SecondaryActivationReadiness(primary, { ...resting, status: "canceled" }),
    { ready: false, reason: "exchange_not_resting" });
  assert.deepEqual(evaluateEth420SecondaryActivationReadiness(primary, { ...resting, clientOrderId: "wrong" }),
    { ready: false, reason: "exchange_identity_uncertain" });
});

test("activation readiness rejects recovery, fill, cancel, and secondary lifecycle ambiguity", () => {
  const primary = {
    id: "primary-id", ticker: "KXETH15M-test", createdAtMs: 0, kalshiOrderId: "primary-order",
    originalPrimaryKalshiOrderId: "primary-order", status: "submitted", filledContracts: null,
    settlementResult: null, lastRecoveryOutcome: null,
  };
  const resting = {
    orderId: "primary-order", clientOrderId: "primary-id", ticker: "KXETH15M-test",
    status: "resting", filledContracts: 0,
  };
  for (const mutation of [
    { lastRecoveryOutcome: "official_result_missing" },
    { filledContracts: 1 },
    { primaryCancelConfirmedAtMs: 1 },
    { secondaryClientOrderId: "secondary" },
    { secondarySubmissionStartedAtMs: 1 },
    { secondaryBoundAtMs: 1 },
    { settlementResult: "yes" as const },
  ]) {
    assert.deepEqual(evaluateEth420SecondaryActivationReadiness({ ...primary, ...mutation }, resting),
      { ready: false, reason: mutation.filledContracts === 1 ? "local_fill_nonzero" : "lifecycle_transition_ambiguous" });
  }
  assert.deepEqual(evaluateEth420SecondaryActivationReadiness({ ...primary, status: "resting_recovered" }, resting),
    { ready: false, reason: "primary_not_ordinary" });
});

test("global activation assessment leaves a clean verified resting primary non-blocking", () => {
  const primary = {
    id: "primary-id", ticker: "KXETH15M-test", createdAtMs: 0, kalshiOrderId: "primary-order",
    originalPrimaryKalshiOrderId: "primary-order", status: "submitted", filledContracts: null,
    settlementResult: null, lastRecoveryOutcome: null,
  };
  const exchangeOrder = {
    orderId: "primary-order", clientOrderId: "primary-id", ticker: "KXETH15M-test",
    status: "resting", filledContracts: 0,
  };
  assert.deepEqual(assessEth420SecondaryGlobalActivation({
    productionHealthy: true, candidateLedgerAvailable: true, candidateLedgerComplete: true,
    emergencyLifecycleExists: false, activationCutover: { version: 1, activatedAtMs: 0 }, candidates: [{ primary, exchangeOrder }],
  }), { safe: true, blockers: [] });
});

test("cutover permanently grandfathers prior primaries while retaining exact-boundary eligibility", async () => {
  const live = process.env["ETH_420_CANDIDATE_LIVE_ENABLED"], secondary = process.env["ETH_420_CANDIDATE_SECONDARY_CROSS_ENABLED"];
  try {
    process.env["ETH_420_CANDIDATE_LIVE_ENABLED"] = "true";
    process.env["ETH_420_CANDIDATE_SECONDARY_CROSS_ENABLED"] = "true";
    const cutover = { version: 1 as const, activatedAtMs: 10_000, reservationSequence: 1 };
    const primary = { id: "grandfathered", ticker: "KXETH15M-test", side: "yes" as const, requestedContracts: 30,
      limitPriceCents: 50, kalshiOrderId: "primary", createdAtMs: 9_999, secondaryActivationSequence: 1 };
    let claimed = 0, cancelled = 0, posted = 0;
    const result = await tryEth420SecondaryEntry({
      primary, reservationAskCents: 55, nowMs: 19_999,
      store: {
        getEth420SecondaryActivationCutover: async () => cutover,
        claimEth420SecondaryEntryAttempt: async () => { claimed++; return true; },
        recordEth420SecondaryEntryEvent: async () => true,
        markEth420CandidateSecondarySubmissionPending: async () => true,
      },
      readPrimary: async () => { throw new Error("pre-cutover primary must not be read"); },
      readSelectedSideAsk: async () => 55,
      cancelPrimary: async () => { cancelled++; return null; },
      submitSecondary: async () => { posted++; return { orderId: "unexpected" }; },
    });
    assert.deepEqual(result, { eligible: false, reason: "pre_activation_primary" });
    assert.deepEqual({ claimed, cancelled, posted }, { claimed: 0, cancelled: 0, posted: 0 });
    assert.deepEqual(assessEth420SecondaryGlobalActivation({
      productionHealthy: true, candidateLedgerAvailable: true, candidateLedgerComplete: true, emergencyLifecycleExists: false,
      activationCutover: cutover, candidates: [{
        primary: { ...primary, kalshiOrderId: "old", originalPrimaryKalshiOrderId: "old", status: "submitted",
          filledContracts: null, settlementResult: null, lastRecoveryOutcome: "official_result_missing" },
        exchangeOrder: null,
      }],
    }), { safe: true, blockers: [] });
    // A reservation immediately after the cutover can share its millisecond,
    // but its lock-ordered sequence remains unambiguously post-cutover.
    const exact = { ...primary, id: "exact-boundary", createdAtMs: cutover.activatedAtMs,
      secondaryActivationSequence: 2, kalshiOrderId: "exact" };
    const exactResult = await tryEth420SecondaryEntry({
      primary: exact, reservationAskCents: 55, nowMs: 20_000,
      store: {
        getEth420SecondaryActivationCutover: async () => cutover,
        claimEth420SecondaryEntryAttempt: async () => true,
        recordEth420SecondaryEntryEvent: async () => true,
        markEth420CandidateSecondarySubmissionPending: async () => true,
      },
      readPrimary: async () => ({ orderId: "exact", clientOrderId: exact.id, ticker: exact.ticker, status: "resting", filledContracts: 0 }),
      readSelectedSideAsk: async () => 55,
      cancelPrimary: async () => ({ orderId: "exact", clientOrderId: exact.id, ticker: exact.ticker, status: "canceled", filledContracts: 0 }),
      submitSecondary: async () => ({ orderId: "secondary" }),
    });
    assert.deepEqual(exactResult, { eligible: true, crossPriceCents: 55 });
  } finally {
    if (live == null) delete process.env["ETH_420_CANDIDATE_LIVE_ENABLED"]; else process.env["ETH_420_CANDIDATE_LIVE_ENABLED"] = live;
    if (secondary == null) delete process.env["ETH_420_CANDIDATE_SECONDARY_CROSS_ENABLED"]; else process.env["ETH_420_CANDIDATE_SECONDARY_CROSS_ENABLED"] = secondary;
  }
});

test("global activation assessment fails closed for incomplete, partial, secondary, and emergency evidence", () => {
  const primary = {
    id: "primary-id", ticker: "KXETH15M-test", createdAtMs: 0, kalshiOrderId: "primary-order",
    originalPrimaryKalshiOrderId: "primary-order", status: "submitted", filledContracts: null,
    settlementResult: null, lastRecoveryOutcome: null,
  };
  const resting = {
    orderId: "primary-order", clientOrderId: "primary-id", ticker: "KXETH15M-test",
    status: "resting", filledContracts: 0,
  };
  const base = {
    productionHealthy: true, candidateLedgerAvailable: true, candidateLedgerComplete: true,
    emergencyLifecycleExists: false, activationCutover: { version: 1 as const, activatedAtMs: 0 },
  };
  assert.deepEqual(assessEth420SecondaryGlobalActivation({
    ...base, candidates: [{ primary, exchangeOrder: { ...resting, filledContracts: null } }],
  }), { safe: false, blockers: [{ candidateId: primary.id, reason: "exchange_fill_uncertain" }] });
  assert.deepEqual(assessEth420SecondaryGlobalActivation({
    ...base, candidates: [{ primary, exchangeOrder: { ...resting, filledContracts: 1 } }],
  }), { safe: false, blockers: [{ candidateId: primary.id, reason: "exchange_fill_nonzero" }] });
  assert.deepEqual(assessEth420SecondaryGlobalActivation({
    ...base, candidates: [{ primary: { ...primary, secondarySubmissionStartedAtMs: 1 }, exchangeOrder: resting }],
  }), { safe: false, blockers: [{ candidateId: primary.id, reason: "lifecycle_transition_ambiguous" }] });
  assert.deepEqual(assessEth420SecondaryGlobalActivation({
    ...base, candidates: [{ primary: { ...primary, secondaryLifecycleTransitionActive: true }, exchangeOrder: resting }],
  }), { safe: false, blockers: [{ candidateId: primary.id, reason: "lifecycle_transition_ambiguous" }] });
  assert.deepEqual(assessEth420SecondaryGlobalActivation({
    ...base, emergencyLifecycleExists: true, candidates: [{ primary, exchangeOrder: resting }],
  }), { safe: false, blockers: [{ candidateId: null, reason: "emergency_lifecycle_exists" }] });
  assert.deepEqual(assessEth420SecondaryGlobalActivation({
    ...base, candidateLedgerComplete: false, candidates: [{ primary, exchangeOrder: resting }],
  }), { safe: false, blockers: [{ candidateId: null, reason: "candidate_ledger_incomplete" }] });
});

test("secondary execution never starts a cancel when its durable cancel audit cannot be recorded", async () => {
  const live = process.env["ETH_420_CANDIDATE_LIVE_ENABLED"], secondary = process.env["ETH_420_CANDIDATE_SECONDARY_CROSS_ENABLED"];
  try {
    process.env["ETH_420_CANDIDATE_LIVE_ENABLED"] = "true"; process.env["ETH_420_CANDIDATE_SECONDARY_CROSS_ENABLED"] = "true";
    let cancelled = 0, posted = 0;
    const primary = { id: "cancel-audit", ticker: "KXETH15M-test", side: "yes" as const, requestedContracts: 30, limitPriceCents: 50, kalshiOrderId: "primary", createdAtMs: 0 };
    const result = await tryEth420SecondaryEntry({
      primary, reservationAskCents: 55, nowMs: ETH420_SECONDARY_ENTRY_OFFSET_MS,
      store: {
        getEth420SecondaryActivationCutover: async () => ({ version: 1, activatedAtMs: 0 }),
        claimEth420SecondaryEntryAttempt: async () => true,
        recordEth420SecondaryEntryEvent: async ({ event }) => event !== "cancel_requested",
        markEth420CandidateSecondarySubmissionPending: async () => true,
      },
      readPrimary: async () => ({ orderId: "primary", clientOrderId: primary.id, ticker: primary.ticker, status: "resting", filledContracts: 0 }),
      readSelectedSideAsk: async () => 55,
      cancelPrimary: async () => { cancelled++; return null; },
      submitSecondary: async () => { posted++; return { orderId: "unexpected" }; },
    });
    assert.deepEqual(result, { eligible: false, reason: "cancel_audit_failed" });
    assert.deepEqual({ cancelled, posted }, { cancelled: 0, posted: 0 });
  } finally {
    if (live == null) delete process.env["ETH_420_CANDIDATE_LIVE_ENABLED"]; else process.env["ETH_420_CANDIDATE_LIVE_ENABLED"] = live;
    if (secondary == null) delete process.env["ETH_420_CANDIDATE_SECONDARY_CROSS_ENABLED"]; else process.env["ETH_420_CANDIDATE_SECONDARY_CROSS_ENABLED"] = secondary;
  }
});

test("secondary decision window permits only a prompt scheduled callback and refuses late activation", async () => {
  const createdAtMs = 1_000;
  assert.equal(isEth420SecondaryDecisionOnTime(createdAtMs, createdAtMs + ETH420_SECONDARY_ENTRY_OFFSET_MS), true);
  assert.equal(isEth420SecondaryDecisionOnTime(createdAtMs, createdAtMs + ETH420_SECONDARY_ENTRY_OFFSET_MS + ETH420_SECONDARY_ENTRY_MAX_TIMER_LATENESS_MS), true);
  assert.equal(isEth420SecondaryDecisionOnTime(createdAtMs, createdAtMs + ETH420_SECONDARY_ENTRY_OFFSET_MS + ETH420_SECONDARY_ENTRY_MAX_TIMER_LATENESS_MS + 1), false);
  const live = process.env["ETH_420_CANDIDATE_LIVE_ENABLED"], secondary = process.env["ETH_420_CANDIDATE_SECONDARY_CROSS_ENABLED"];
  try {
    process.env["ETH_420_CANDIDATE_LIVE_ENABLED"] = "true"; process.env["ETH_420_CANDIDATE_SECONDARY_CROSS_ENABLED"] = "true";
    let claimed = 0, cancelled = 0, posted = 0;
    const primary = { id: "late", ticker: "KXETH15M-test", side: "yes" as const, requestedContracts: 30, limitPriceCents: 50, kalshiOrderId: "primary", createdAtMs };
    const result = await tryEth420SecondaryEntry({
      primary, reservationAskCents: 55,
      nowMs: createdAtMs + ETH420_SECONDARY_ENTRY_OFFSET_MS + ETH420_SECONDARY_ENTRY_MAX_TIMER_LATENESS_MS + 1,
      store: {
        getEth420SecondaryActivationCutover: async () => ({ version: 1, activatedAtMs: 0 }),
        claimEth420SecondaryEntryAttempt: async () => { claimed++; return true; },
        recordEth420SecondaryEntryEvent: async () => true,
        markEth420CandidateSecondarySubmissionPending: async () => true,
      },
      readPrimary: async () => ({ orderId: "primary", clientOrderId: primary.id, ticker: primary.ticker, status: "resting", filledContracts: 0 }),
      readSelectedSideAsk: async () => 55,
      cancelPrimary: async () => { cancelled++; return null; },
      submitSecondary: async () => { posted++; return { orderId: "unexpected" }; },
    });
    assert.deepEqual(result, { eligible: false, reason: "missed_offset" });
    assert.deepEqual({ claimed, cancelled, posted }, { claimed: 0, cancelled: 0, posted: 0 });
  } finally {
    if (live == null) delete process.env["ETH_420_CANDIDATE_LIVE_ENABLED"]; else process.env["ETH_420_CANDIDATE_LIVE_ENABLED"] = live;
    if (secondary == null) delete process.env["ETH_420_CANDIDATE_SECONDARY_CROSS_ENABLED"]; else process.env["ETH_420_CANDIDATE_SECONDARY_CROSS_ENABLED"] = secondary;
  }
});

test("a cancel audit delayed across the deadline never cancels or posts a secondary", async () => {
  const live = process.env["ETH_420_CANDIDATE_LIVE_ENABLED"], secondary = process.env["ETH_420_CANDIDATE_SECONDARY_CROSS_ENABLED"];
  try {
    process.env["ETH_420_CANDIDATE_LIVE_ENABLED"] = "true"; process.env["ETH_420_CANDIDATE_SECONDARY_CROSS_ENABLED"] = "true";
    const createdAtMs = 1_000;
    let clock = createdAtMs + ETH420_SECONDARY_ENTRY_OFFSET_MS, cancelled = 0, posted = 0;
    const primary = { id: "delayed-before-cancel", ticker: "KXETH15M-test", side: "yes" as const, requestedContracts: 30, limitPriceCents: 50, kalshiOrderId: "primary", createdAtMs };
    const result = await tryEth420SecondaryEntry({
      primary, reservationAskCents: 55, nowMs: clock, getCurrentTimeMs: () => clock,
      store: {
        getEth420SecondaryActivationCutover: async () => ({ version: 1, activatedAtMs: 0 }),
        claimEth420SecondaryEntryAttempt: async () => true,
        recordEth420SecondaryEntryEvent: async (event) => {
          if (event.event === "cancel_requested") clock += ETH420_SECONDARY_ENTRY_MAX_TIMER_LATENESS_MS + 1;
          return true;
        },
        markEth420CandidateSecondarySubmissionPending: async () => true,
      },
      readPrimary: async () => ({ orderId: "primary", clientOrderId: primary.id, ticker: primary.ticker, status: "resting", filledContracts: 0 }),
      readSelectedSideAsk: async () => 55,
      cancelPrimary: async () => { cancelled++; return null; },
      submitSecondary: async () => { posted++; return { orderId: "unexpected" }; },
    });
    assert.deepEqual(result, { eligible: false, reason: "missed_offset" });
    assert.deepEqual({ cancelled, posted }, { cancelled: 0, posted: 0 });
  } finally {
    if (live == null) delete process.env["ETH_420_CANDIDATE_LIVE_ENABLED"]; else process.env["ETH_420_CANDIDATE_LIVE_ENABLED"] = live;
    if (secondary == null) delete process.env["ETH_420_CANDIDATE_SECONDARY_CROSS_ENABLED"]; else process.env["ETH_420_CANDIDATE_SECONDARY_CROSS_ENABLED"] = secondary;
  }
});

test("a submit audit delayed after cancellation never posts a secondary", async () => {
  const live = process.env["ETH_420_CANDIDATE_LIVE_ENABLED"], secondary = process.env["ETH_420_CANDIDATE_SECONDARY_CROSS_ENABLED"];
  try {
    process.env["ETH_420_CANDIDATE_LIVE_ENABLED"] = "true"; process.env["ETH_420_CANDIDATE_SECONDARY_CROSS_ENABLED"] = "true";
    const createdAtMs = 1_000;
    let clock = createdAtMs + ETH420_SECONDARY_ENTRY_OFFSET_MS, cancelled = 0, checkpointed = 0, posted = 0;
    const primary = { id: "delayed-before-submit", ticker: "KXETH15M-test", side: "yes" as const, requestedContracts: 30, limitPriceCents: 50, kalshiOrderId: "primary", createdAtMs };
    const result = await tryEth420SecondaryEntry({
      primary, reservationAskCents: 55, nowMs: clock, getCurrentTimeMs: () => clock,
      store: {
        getEth420SecondaryActivationCutover: async () => ({ version: 1, activatedAtMs: 0 }),
        claimEth420SecondaryEntryAttempt: async () => true,
        recordEth420SecondaryEntryEvent: async (event) => {
          if (event.event === "submit_started") clock += ETH420_SECONDARY_ENTRY_MAX_TIMER_LATENESS_MS + 1;
          return true;
        },
        markEth420CandidateSecondarySubmissionPending: async () => { checkpointed++; return true; },
      },
      readPrimary: async () => ({ orderId: "primary", clientOrderId: primary.id, ticker: primary.ticker, status: "resting", filledContracts: 0 }),
      readSelectedSideAsk: async () => 55,
      cancelPrimary: async () => { cancelled++; return { orderId: "primary", clientOrderId: primary.id, ticker: primary.ticker, status: "canceled", filledContracts: 0 }; },
      submitSecondary: async () => { posted++; return { orderId: "unexpected" }; },
    });
    assert.deepEqual(result, { eligible: false, reason: "missed_offset" });
    assert.deepEqual({ cancelled, checkpointed, posted }, { cancelled: 1, checkpointed: 1, posted: 0 });
  } finally {
    if (live == null) delete process.env["ETH_420_CANDIDATE_LIVE_ENABLED"]; else process.env["ETH_420_CANDIDATE_LIVE_ENABLED"] = live;
    if (secondary == null) delete process.env["ETH_420_CANDIDATE_SECONDARY_CROSS_ENABLED"]; else process.env["ETH_420_CANDIDATE_SECONDARY_CROSS_ENABLED"] = secondary;
  }
});

test("secondary execution claims once, cancels before posting, and retains the original side and size", async () => {
  const live = process.env["ETH_420_CANDIDATE_LIVE_ENABLED"], secondary = process.env["ETH_420_CANDIDATE_SECONDARY_CROSS_ENABLED"], nodeEnv = process.env.NODE_ENV;
    const events: string[] = [], sequence: string[] = [];
  try {
    process.env["ETH_420_CANDIDATE_LIVE_ENABLED"] = "true"; process.env["ETH_420_CANDIDATE_SECONDARY_CROSS_ENABLED"] = "true"; process.env.NODE_ENV = "test";
    const primary = { id: "KXETH15M-test:eth420-live-v1", ticker: "KXETH15M-test", side: "no" as const, requestedContracts: 840, limitPriceCents: 50, kalshiOrderId: "primary", createdAtMs: 1 };
    const result = await tryEth420SecondaryEntry({
      primary, reservationAskCents: 55, nowMs: 1 + ETH420_SECONDARY_ENTRY_OFFSET_MS,
      store: {
        getEth420SecondaryActivationCutover: async () => ({ version: 1, activatedAtMs: 0 }),
        claimEth420SecondaryEntryAttempt: async () => true,
        recordEth420SecondaryEntryEvent: async ({ event }) => { events.push(event); return true; },
        markEth420CandidateSecondarySubmissionPending: async () => { sequence.push("checkpoint"); return true; },
      },
      readPrimary: async () => ({ orderId: "primary", clientOrderId: primary.id, ticker: primary.ticker, status: "resting", filledContracts: 0 }),
      readSelectedSideAsk: async () => 55,
      cancelPrimary: async () => { sequence.push("cancel"); return { orderId: "primary", clientOrderId: primary.id, ticker: primary.ticker, status: "canceled", filledContracts: 0 }; },
      submitSecondary: async (request) => { sequence.push("submit"); assert.deepEqual(request, { clientOrderId: `${primary.id}:secondary-v1`, ticker: primary.ticker, side: "no", contracts: 840, priceCents: 55 }); return { orderId: "secondary" }; },
    });
    assert.deepEqual(result, { eligible: true, crossPriceCents: 55 });
    assert.deepEqual(sequence, ["cancel", "checkpoint", "submit"]);
    assert.deepEqual(events, ["cancel_requested", "cancel_confirmed", "submit_started", "bind_confirmed"]);
  } finally {
    if (live == null) delete process.env["ETH_420_CANDIDATE_LIVE_ENABLED"]; else process.env["ETH_420_CANDIDATE_LIVE_ENABLED"] = live;
    if (secondary == null) delete process.env["ETH_420_CANDIDATE_SECONDARY_CROSS_ENABLED"]; else process.env["ETH_420_CANDIDATE_SECONDARY_CROSS_ENABLED"] = secondary;
    if (nodeEnv == null) delete process.env.NODE_ENV; else process.env.NODE_ENV = nodeEnv;
  }
});

test("secondary execution fails closed on identity uncertainty, cancellation fills, and duplicate claim", async () => {
  const live = process.env["ETH_420_CANDIDATE_LIVE_ENABLED"], secondary = process.env["ETH_420_CANDIDATE_SECONDARY_CROSS_ENABLED"], nodeEnv = process.env.NODE_ENV;
  try {
    process.env["ETH_420_CANDIDATE_LIVE_ENABLED"] = "true"; process.env["ETH_420_CANDIDATE_SECONDARY_CROSS_ENABLED"] = "true"; process.env.NODE_ENV = "test";
    const primary = { id: "id", ticker: "KXETH15M-test", side: "yes" as const, requestedContracts: 30, limitPriceCents: 50, kalshiOrderId: "primary", createdAtMs: 0 };
    for (const scenario of [
      { claimed: false, read: { orderId: "primary", clientOrderId: "id", ticker: primary.ticker, status: "resting", filledContracts: 0 }, cancel: { orderId: "primary", clientOrderId: "id", ticker: primary.ticker, status: "canceled", filledContracts: 0 }, reason: "attempt_already_claimed" },
      { claimed: true, read: { orderId: "wrong", clientOrderId: "id", ticker: primary.ticker, status: "resting", filledContracts: 0 }, cancel: null, reason: "primary_identity_mismatch" },
      { claimed: true, read: { orderId: "primary", clientOrderId: "id", ticker: primary.ticker, status: "resting", filledContracts: 0 }, cancel: { orderId: "primary", clientOrderId: "id", ticker: primary.ticker, status: "canceled", filledContracts: 1 }, reason: "cancel_nonzero_fill" },
    ]) {
      let posts = 0;
      const result = await tryEth420SecondaryEntry({
        primary, reservationAskCents: 55, nowMs: ETH420_SECONDARY_ENTRY_OFFSET_MS,
        store: {
          getEth420SecondaryActivationCutover: async () => ({ version: 1, activatedAtMs: 0 }),
          claimEth420SecondaryEntryAttempt: async () => scenario.claimed,
          recordEth420SecondaryEntryEvent: async () => true,
          markEth420CandidateSecondarySubmissionPending: async () => true,
        },
        readPrimary: async () => scenario.read, readSelectedSideAsk: async () => 55,
        cancelPrimary: async () => scenario.cancel, submitSecondary: async () => { posts++; return { orderId: "unexpected" }; },
      });
      assert.deepEqual(result, { eligible: false, reason: scenario.reason }); assert.equal(posts, 0);
    }
  } finally {
    if (live == null) delete process.env["ETH_420_CANDIDATE_LIVE_ENABLED"]; else process.env["ETH_420_CANDIDATE_LIVE_ENABLED"] = live;
    if (secondary == null) delete process.env["ETH_420_CANDIDATE_SECONDARY_CROSS_ENABLED"]; else process.env["ETH_420_CANDIDATE_SECONDARY_CROSS_ENABLED"] = secondary;
    if (nodeEnv == null) delete process.env.NODE_ENV; else process.env.NODE_ENV = nodeEnv;
  }
});

test("secondary submission never posts after the durable cancel checkpoint fails", async () => {
  const live = process.env["ETH_420_CANDIDATE_LIVE_ENABLED"], secondary = process.env["ETH_420_CANDIDATE_SECONDARY_CROSS_ENABLED"];
  try {
    process.env["ETH_420_CANDIDATE_LIVE_ENABLED"] = "true"; process.env["ETH_420_CANDIDATE_SECONDARY_CROSS_ENABLED"] = "true";
    let posts = 0;
    const primary = { id: "checkpoint", ticker: "KXETH15M-test", side: "yes" as const, requestedContracts: 30, limitPriceCents: 50, kalshiOrderId: "primary", createdAtMs: 0 };
    const result = await tryEth420SecondaryEntry({
      primary, reservationAskCents: 55, nowMs: ETH420_SECONDARY_ENTRY_OFFSET_MS,
      store: {
        getEth420SecondaryActivationCutover: async () => ({ version: 1, activatedAtMs: 0 }),
        claimEth420SecondaryEntryAttempt: async () => true, recordEth420SecondaryEntryEvent: async () => true,
        markEth420CandidateSecondarySubmissionPending: async () => false,
      },
      readPrimary: async () => ({ orderId: "primary", clientOrderId: primary.id, ticker: primary.ticker, status: "resting", filledContracts: 0 }),
      readSelectedSideAsk: async () => 55,
      cancelPrimary: async () => ({ orderId: "primary", clientOrderId: primary.id, ticker: primary.ticker, status: "canceled", filledContracts: 0 }),
      submitSecondary: async () => { posts++; return { orderId: "bad" }; },
    });
    assert.deepEqual(result, { eligible: false, reason: "secondary_checkpoint_failed" }); assert.equal(posts, 0);
  } finally {
    if (live == null) delete process.env["ETH_420_CANDIDATE_LIVE_ENABLED"]; else process.env["ETH_420_CANDIDATE_LIVE_ENABLED"] = live;
    if (secondary == null) delete process.env["ETH_420_CANDIDATE_SECONDARY_CROSS_ENABLED"]; else process.env["ETH_420_CANDIDATE_SECONDARY_CROSS_ENABLED"] = secondary;
  }
});