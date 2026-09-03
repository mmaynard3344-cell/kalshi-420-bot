import assert from "node:assert/strict";
import test from "node:test";
import {
  allowlistedCompactPayload, scoreCompactShadow, opportunityAccumulators, restoreOpportunityAccumulator,
   classifyNormalizedDistance, isNormalizedDistanceExperimentEligible, normalizedDistanceSourceUnavailableReason,
   summarizeDirectionalResults, wilsonInterval,
   resolveCompactLedgerCheckpoint, classifyCompactUnreadChunk, commitCompactLedgerCheckpoint,
    checkpointForSecondsRemaining, compactStudyUnavailableReason, compactPersistenceQualification, isCompactShock, isShockHorizonDue,
    compactOutcomeStatusForHttp,
} from "./compactShadowWorker.js";

const completeFreshEvidence = {
  data_fresh: true,
  data_complete: true,
  coinbase_microstructure_complete: true,
  kalshi_executable_complete: true,
  latency_complete: true,
  source_latency_ms: 1,
  snapshot_latency_ms: 1,
  source_clock_skew_ms: 0,
  kalshi_fetch_latency_ms: 1,
  window_fetch_latency_ms: 1,
};

test("compact scorer fails closed for stale or incomplete evidence", () => {
  const score = scoreCompactShadow({ feed_status: "stale", raw_ticks_persisted: false });
  assert.equal(score.action, "SKIP");
  assert.equal(score.finishProbability, null);
  assert.equal(score.touchProbability, null);
});

test("compact scorer keeps touch and finish probabilities separate", () => {
  // Use target < reference (direction=-1) so touch = max(1-finish, exp(-d*0.65))
  // which is guaranteed to differ from finish when distance=1.
  const score = scoreCompactShadow({
    ...completeFreshEvidence,
    feed_status: "fresh", age_ms: 1, seconds_remaining: 60,
    current_reference_price: 100, target_price: 99,
    normalized_distance_volatility_units: 1, expected_movement_to_close_dollars: 2,
    kalshi_yes_weighted_executable_price_cents: 45, kalshi_no_weighted_executable_price_cents: 60,
    coinbase_microstructure_age_ms: 1, kalshi_orderbook_age_ms: 1,
  });
  assert.notEqual(score.finishProbability, null);
  assert.notEqual(score.touchProbability, null);
  assert.notEqual(score.finishProbability, score.touchProbability);
  assert.notEqual(score.action, "SKIP");
});

test("compact scorer fails closed when executable microstructure is missing or stale", () => {
  const score = scoreCompactShadow({ ...completeFreshEvidence, feed_status: "fresh", age_ms: 1, seconds_remaining: 60, current_reference_price: 100, target_price: 101, normalized_distance_volatility_units: 1, expected_movement_to_close_dollars: 2, kalshi_yes_weighted_executable_price_cents: 45, kalshi_no_weighted_executable_price_cents: 60, coinbase_microstructure_age_ms: 30_000, kalshi_orderbook_age_ms: 1 });
  assert.equal(score.action, "SKIP");
  assert.equal(score.reason, "missing_or_stale_compact_evidence");
});

test("compact scorer fails closed when public fetch latency exceeds its bound", () => {
  const score = scoreCompactShadow({
    ...completeFreshEvidence,
    kalshi_fetch_latency_ms: 5_001,
    feed_status: "fresh", age_ms: 1, seconds_remaining: 60,
    current_reference_price: 100, target_price: 101,
    normalized_distance_volatility_units: 1, expected_movement_to_close_dollars: 2,
    kalshi_yes_weighted_executable_price_cents: 45, kalshi_no_weighted_executable_price_cents: 60,
    coinbase_microstructure_age_ms: 1, kalshi_orderbook_age_ms: 1,
  });
  assert.equal(score.action, "SKIP");
  assert.equal(score.reason, "missing_or_stale_compact_evidence");
});

test("compact allowlist rejects raw-shaped records", () => {
  assert.equal(allowlistedCompactPayload({ raw_ticks_persisted: false, ticks: [] }), null);
  assert.equal(allowlistedCompactPayload({ raw_ticks_persisted: true }), null);
});

test("compact allowlist rejects unknown fields", () => {
  // Fields not in the strict scalar allowlist must be rejected
  assert.equal(allowlistedCompactPayload({ raw_ticks_persisted: false, unknown_field_xyz: 1 }), null);
});

test("compact allowlist rejects nested/object values", () => {
  // Objects and arrays are never allowed even if the key is in the allowlist
  assert.equal(allowlistedCompactPayload({ raw_ticks_persisted: false, status: { nested: true } }), null);
  assert.equal(allowlistedCompactPayload({ raw_ticks_persisted: false, status: [1, 2, 3] }), null);
});

test("compact allowlist accepts new scalar fields: regime, latency_ms, signal_concurrence, coinbase_kalshi_model_divergence_cents", () => {
  const result = allowlistedCompactPayload({
    raw_ticks_persisted: false,
    regime: "trending",
    latency_ms: 42,
    snapshot_latency_ms: 18,
    signal_concurrence: true,
    coinbase_kalshi_model_divergence_cents: 3.5,
  });
  assert.notEqual(result, null);
  assert.equal(result!.regime, "trending");
  assert.equal(result!.latency_ms, 42);
  assert.equal(result!.snapshot_latency_ms, 18);
  assert.equal(result!.signal_concurrence, true);
  assert.equal(result!.coinbase_kalshi_model_divergence_cents, 3.5);
});

test("compact allowlist: null values are allowed for allowlisted scalar fields", () => {
  const result = allowlistedCompactPayload({
    raw_ticks_persisted: false,
    regime: null,
    latency_ms: null,
  });
  assert.notEqual(result, null);
  assert.equal(result!.regime, null);
  assert.equal(result!.latency_ms, null);
});

test("compact allowlist accepts the expanded bounded lifecycle contract", () => {
  const result = allowlistedCompactPayload({
    raw_ticks_persisted: false,
    path_breakout_count: 2,
    feature_range_expansion_dollars: 3.25,
    kalshi_yes_executable_principal_cents_5c_slippage: 1_700,
    path_peak_yes_principal_cents_5c: 2_400,
    source_timestamp_ms: 1_000,
    source_receipt_ms: 1_005,
    source_clock_skew_ms: 5,
    coinbase_microstructure_complete: true,
    kalshi_executable_complete: true,
    latency_complete: true,
    path_summary_complete: true,
    lifecycle_peak_yes_executable_price_cents: 91,
    lifecycle_min_yes_executable_price_cents: 42,
    lifecycle_yes_first_90_ms: 8_000,
    lifecycle_yes_recovery_80_duration_ms: 4_000,
    lifecycle_final_reference_price: 100_123,
  });
  assert.notEqual(result, null);
  assert.equal(result!.path_peak_yes_principal_cents_5c, 2_400);
  assert.equal(result!.lifecycle_yes_first_90_ms, 8_000);
});

test("opportunity accumulator is exported and starts empty for new tickers", () => {
  // The map is module-level; we just check it's a Map
  assert.ok(opportunityAccumulators instanceof Map);
});

test("opportunity accumulator restores durable totals after a worker restart", () => {
  opportunityAccumulators.delete("KXBTC15M-RESTORE");
  const restored = restoreOpportunityAccumulator("KXBTC15M-RESTORE", "BTC", {
    recorded_at_ms: 10_000,
    acc_peak_edge_cents: 7,
    acc_peak_edge_ms: 8_000,
    acc_edge_duration_ms: 45_000,
    acc_executable_positive_duration_ms: 30_000,
    acc_signal_concurrence_count: 2,
    acc_snapshot_count: 3,
    acc_max_model_divergence_cents: 4,
    acc_avg_model_divergence_cents: 2,
    acc_model_divergence_observation_count: 3,
  });
  assert.equal(restored.edgeDurationMs, 45_000);
  assert.equal(restored.sumModelDivergenceCents, 6);
  assert.equal(restored.lastSnapshotMs, 10_000);
});

test("compact scorer WOULD_BUY when edge is high", () => {
  // edge = finishProbability*100 - yesAsk; make finishProb high, yesAsk low
  const score = scoreCompactShadow({
    ...completeFreshEvidence,
    feed_status: "fresh", age_ms: 1, seconds_remaining: 60,
    current_reference_price: 100, target_price: 101,
    normalized_distance_volatility_units: 0.1, expected_movement_to_close_dollars: 5,
    kalshi_yes_weighted_executable_price_cents: 40, kalshi_no_weighted_executable_price_cents: 60,
    coinbase_microstructure_age_ms: 1, kalshi_orderbook_age_ms: 1,
  });
  // finishProbability ~ 0.5 + 1 * exp(-0.1) * 0.22 ≈ 0.699 => edge ≈ 69.9 - 40 = 29.9 >= 4
  assert.equal(score.action, "WOULD_BUY");
  assert.equal(score.confidence, "high");
});

test("compact scorer WOULD_EXIT when edge is very negative", () => {
  // target below reference (direction = -1), ask is high
  const score = scoreCompactShadow({
    ...completeFreshEvidence,
    feed_status: "fresh", age_ms: 1, seconds_remaining: 60,
    current_reference_price: 101, target_price: 100,
    normalized_distance_volatility_units: 0.1, expected_movement_to_close_dollars: 5,
    kalshi_yes_weighted_executable_price_cents: 60, kalshi_no_weighted_executable_price_cents: 90,
    coinbase_microstructure_age_ms: 1, kalshi_orderbook_age_ms: 1,
  });
  // direction=-1, edge = (1-finishProb)*100 - noAsk = ~30.1 - 90 = -59.9 <= -4
  assert.equal(score.action, "WOULD_EXIT");
});

test("normalized-distance experiment freezes exact directional boundaries", () => {
  assert.equal(classifyNormalizedDistance(0.25), "yes");
  assert.equal(classifyNormalizedDistance(-0.25), "no");
  assert.equal(classifyNormalizedDistance(0.249999), "neutral");
  assert.equal(classifyNormalizedDistance(-0.249999), "neutral");
  assert.equal(classifyNormalizedDistance(null), "unavailable");
});

test("normalized-distance experiment only enrolls complete snapshots from new, pre-close windows", () => {
  const start = Date.parse("2026-08-21T23:00:24.446Z");
  const row = {
    recorded_at_ms: start + 1_000,
    window_open_ms: start,
    window_close_ms: start + 900_000,
  };
  const payload = {
    ...completeFreshEvidence,
    feed_status: "fresh",
    normalized_distance_volatility_units: 0.25,
    source_timestamp_ms: row.recorded_at_ms,
  };
  assert.equal(isNormalizedDistanceExperimentEligible(row, payload), true);
  assert.equal(isNormalizedDistanceExperimentEligible({ ...row, window_open_ms: start - 1 }, payload), false);
  assert.equal(isNormalizedDistanceExperimentEligible({ ...row, recorded_at_ms: row.window_close_ms }, payload), false);
  assert.equal(isNormalizedDistanceExperimentEligible(row, { ...payload, data_complete: false }), false);
  assert.equal(isNormalizedDistanceExperimentEligible(row, { ...payload, normalized_distance_volatility_units: null }), false);
});

test("normalized-distance enrollment requires an in-window causal Coinbase source observation", () => {
  const start = Date.parse("2026-08-21T23:00:24.446Z");
  const row = {
    recorded_at_ms: start + 10_000,
    window_open_ms: start,
    window_close_ms: start + 900_000,
  };
  const payload = {
    ...completeFreshEvidence,
    feed_status: "fresh",
    normalized_distance_volatility_units: 0.25,
    source_timestamp_ms: row.window_open_ms,
  };
  // Window-open and capture-time boundaries are causal and accepted.
  assert.equal(isNormalizedDistanceExperimentEligible(row, payload), true);
  assert.equal(isNormalizedDistanceExperimentEligible(row, { ...payload, source_timestamp_ms: row.recorded_at_ms }), true);
  assert.equal(normalizedDistanceSourceUnavailableReason(row, { ...payload, source_timestamp_ms: row.window_open_ms - 1 }), "source_before_window");
  assert.equal(isNormalizedDistanceExperimentEligible(row, { ...payload, source_timestamp_ms: row.window_open_ms - 1 }), false);
  assert.equal(normalizedDistanceSourceUnavailableReason(row, { ...payload, source_timestamp_ms: null }), "missing_source_observation");
  assert.equal(isNormalizedDistanceExperimentEligible(row, { ...payload, source_timestamp_ms: null }), false);
  assert.equal(normalizedDistanceSourceUnavailableReason(row, { ...payload, source_timestamp_ms: row.recorded_at_ms + 1 }), "source_after_capture");
  assert.equal(isNormalizedDistanceExperimentEligible(row, { ...payload, source_timestamp_ms: row.recorded_at_ms + 1 }), false);
});

test("normalized-distance source rejection never changes the later valid enrollment decision", () => {
  const start = Date.parse("2026-08-21T23:00:24.446Z");
  const row = { recorded_at_ms: start + 5_000, window_open_ms: start, window_close_ms: start + 900_000 };
  const evidence = { ...completeFreshEvidence, feed_status: "fresh", normalized_distance_volatility_units: -0.25 };
  const rejectedFirst = { ...evidence, source_timestamp_ms: start - 1 };
  const validLater = { ...evidence, source_timestamp_ms: start + 5_000 };
  assert.equal(isNormalizedDistanceExperimentEligible(row, rejectedFirst), false);
  assert.equal(classifyNormalizedDistance(rejectedFirst.normalized_distance_volatility_units), "no");
  assert.equal(isNormalizedDistanceExperimentEligible(row, validLater), true);
  assert.equal(classifyNormalizedDistance(validLater.normalized_distance_volatility_units), "no");
});

test("compact checkpoints enroll only at fixed remaining-time boundaries", () => {
  assert.equal(checkpointForSecondsRemaining(601), null);
  assert.equal(checkpointForSecondsRemaining(600), 600);
  assert.equal(checkpointForSecondsRemaining(599.9), 600);
  assert.equal(checkpointForSecondsRemaining(450), 450);
  assert.equal(checkpointForSecondsRemaining(59), 60);
  // A delayed final-minute observation must never masquerade as a 10, 7.5,
  // 5, 3, or 2-minute checkpoint.
  assert.notEqual(checkpointForSecondsRemaining(59), 600);
  assert.notEqual(checkpointForSecondsRemaining(59), 120);
});

test("new compact studies fail closed for out-of-window, incomplete, and invalid-source evidence", () => {
  const row = { recorded_at_ms: Date.parse("2026-08-22T00:01:00Z"), window_open_ms: Date.parse("2026-08-22T00:00:00Z"), window_close_ms: Date.parse("2026-08-22T00:15:00Z") };
  const payload = { ...completeFreshEvidence, feed_status: "fresh", source_timestamp_ms: row.recorded_at_ms };
  assert.equal(compactStudyUnavailableReason(row, payload), null);
  assert.equal(compactStudyUnavailableReason({ ...row, recorded_at_ms: 20_000 }, payload), "outside_window");
  assert.equal(compactStudyUnavailableReason(row, { ...payload, data_complete: false }), "incomplete_or_stale");
  assert.equal(compactStudyUnavailableReason(row, { ...payload, source_timestamp_ms: 999 }), "source_before_window");
  assert.equal(compactStudyUnavailableReason({ ...row, window_open_ms: row.window_open_ms - 1 }, payload), "before_study_start");
});

test("persistence requires beyond-threshold direction with uninterrupted bounded hold", () => {
  const held = { normalized_distance_volatility_units: 0.25, path_longest_above_target_ms: 60_000, path_time_since_last_cross_ms: 60_000, distance_to_target_dollars: 2, path_max_distance_above_target: 3 };
  assert.equal(compactPersistenceQualification(held, 60), "yes");
  assert.equal(compactPersistenceQualification({ ...held, path_time_since_last_cross_ms: 59_999 }, 60), "unavailable");
  assert.equal(compactPersistenceQualification({ ...held, normalized_distance_volatility_units: 0.24 }, 60), "unavailable");
});

test("Coinbase shock rule uses frozen velocity OR trade-flow thresholds inclusively", () => {
  assert.equal(isCompactShock({ velocity_dollars_per_second_30s: 0.25 }), true);
  assert.equal(isCompactShock({ velocity_dollars_per_second_30s: -0.25 }), true);
  assert.equal(isCompactShock({ coinbase_trade_flow_imbalance_60s: 0.50 }), true);
  assert.equal(isCompactShock({ velocity_dollars_per_second_30s: 0.249, coinbase_trade_flow_imbalance_60s: 0.499 }), false);
});

test("shock horizons never label a later compact observation as an earlier interval", () => {
  assert.equal(isShockHorizonDue(5_000, 5), true);
  assert.equal(isShockHorizonDue(7_500, 5), true);
  assert.equal(isShockHorizonDue(7_501, 5), false);
  assert.equal(isShockHorizonDue(15_000, 5), false);
  assert.equal(isShockHorizonDue(15_000, 15), true);
});

test("normalized-distance report separates assets, neutral calls, and call-side accuracy", () => {
  const rows = [
    { asset: "BTC" as const, direction: "yes" as const, result: "yes" as const },
    { asset: "BTC" as const, direction: "no" as const, result: "yes" as const },
    { asset: "BTC" as const, direction: "neutral" as const, result: "no" as const },
    { asset: "ETH" as const, direction: "no" as const, result: "no" as const },
    { asset: "ETH" as const, direction: "yes" as const, result: null },
  ];
  const [btc, eth, combined] = summarizeDirectionalResults(rows);
  assert.equal(btc.directionalCount, 2);
  assert.equal(btc.correctCount, 1);
  assert.equal(btc.neutralCount, 1);
  assert.equal(btc.yesAccuracy, 1);
  assert.equal(btc.noAccuracy, 0);
  assert.equal(eth.pendingCount, 1);
  assert.equal(combined.directionalCount, 3);
  assert.equal(combined.correctCount, 2);
});

test("Wilson interval is absent without settled directional calls and bounded otherwise", () => {
  assert.deepEqual(wilsonInterval(0, 0), { low: null, high: null });
  const interval = wilsonInterval(8, 10);
  assert.ok(interval.low !== null && interval.low > 0 && interval.low < 0.8);
  assert.ok(interval.high !== null && interval.high > 0.8 && interval.high < 1);
});

test("compact ledger resumes from its durable cursor without a bounded-tail skip", () => {
  const prior = {
    device: "1", inode: "2", byteOffset: 12_000_000, lastRecordId: "old",
    lastRecordAtMs: 1, status: "healthy", lastReason: null, rejectedCount: 0,
    malformedCount: 0, writeFailureCount: 0, lostRecordCount: 0, rotationCount: 0, truncationCount: 0,
  };
  const result = resolveCompactLedgerCheckpoint(prior, { device: "1", inode: "2", size: 20_000_000 });
  assert.equal(result.reason, "resumed");
  assert.equal(result.checkpoint.byteOffset, 12_000_000);
});

test("compact ledger records a durable loss reason on rotation or truncation", () => {
  const prior = {
    device: "1", inode: "2", byteOffset: 1_000, lastRecordId: "old",
    lastRecordAtMs: 1, status: "healthy", lastReason: null, rejectedCount: 0,
    malformedCount: 0, writeFailureCount: 0, lostRecordCount: 0, rotationCount: 0, truncationCount: 0,
  };
  const rotated = resolveCompactLedgerCheckpoint(prior, { device: "1", inode: "3", size: 100 });
  assert.equal(rotated.reason, "rotated");
  assert.equal(rotated.checkpoint.byteOffset, 0);
  assert.equal(rotated.checkpoint.rotationCount, 1);
  assert.equal(rotated.checkpoint.lostRecordCount, 1);
  assert.equal(rotated.checkpoint.lastReason, "ledger_rotation_before_checkpoint");
  const truncated = resolveCompactLedgerCheckpoint(prior, { device: "1", inode: "2", size: 100 });
  assert.equal(truncated.reason, "truncated");
  assert.equal(truncated.checkpoint.truncationCount, 1);
  assert.equal(truncated.checkpoint.lastReason, "ledger_truncated_before_checkpoint");
});

test("compact ledger treats incomplete and oversized records as explicit non-advance states", () => {
  assert.equal(classifyCompactUnreadChunk(-1, 50), "partial");
  assert.equal(classifyCompactUnreadChunk(-1, 1_048_576), "oversized");
  assert.equal(classifyCompactUnreadChunk(99, 1_048_576), "complete");
});

test("compact ledger retries accepted and malformed records when checkpoint persistence fails", async () => {
  const durable = {
    device: "1", inode: "2", byteOffset: 0, lastRecordId: null, lastRecordAtMs: null,
    status: "healthy", lastReason: null, rejectedCount: 0, malformedCount: 0,
    writeFailureCount: 0, lostRecordCount: 0, rotationCount: 0, truncationCount: 0,
  };
  const cache = new Map([["ledger.ndjson", durable]]);
  const acceptedCandidate = { ...durable, byteOffset: 100, lastRecordId: "accepted", lastRecordAtMs: 100 };
  const malformedCandidate = {
    ...durable, byteOffset: 50, status: "loss_detected", lastReason: "malformed_ndjson_record",
    rejectedCount: 1, malformedCount: 1, lostRecordCount: 1,
  };

  for (const candidate of [acceptedCandidate, malformedCandidate]) {
    cache.set("ledger.ndjson", { ...durable });
    let attempts = 0;
    await assert.rejects(
      commitCompactLedgerCheckpoint(cache, "ledger.ndjson", candidate, async () => {
        attempts++;
        throw new Error("checkpoint write unavailable");
      }),
      /checkpoint write unavailable/,
    );
    // A failed checkpoint must retain the last durable cursor for a retry.
    assert.equal(cache.get("ledger.ndjson")!.byteOffset, 0);

    await commitCompactLedgerCheckpoint(cache, "ledger.ndjson", candidate, async () => {
      attempts++;
    });
    assert.equal(attempts, 2);
    assert.equal(cache.get("ledger.ndjson")!.byteOffset, candidate.byteOffset);
    assert.equal(cache.get("ledger.ndjson")!.rejectedCount, candidate.rejectedCount);
  }
});

test("a confirmed public market 404 is terminal unavailable evidence, not a result", () => {
  assert.equal(compactOutcomeStatusForHttp(404), "unavailable_http_404");
  assert.equal(compactOutcomeStatusForHttp(429), null);
  assert.equal(compactOutcomeStatusForHttp(500), null);
  assert.equal(compactOutcomeStatusForHttp(200), null);
});
