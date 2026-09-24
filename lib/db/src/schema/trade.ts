/**
 * SQL schema for durable trading state.
 *
 * Eight tables replace the runtime-written JSON/NDJSON files in data/:
 *   order_attempts       ← analytics/orders-*.ndjson
 *   daily_budget         ← daily-budget.json
 *   order_dedup          ← order-dedup.json
 *   market_results       ← market-result-cache.json
 *   passive_observations ← three-minute-observations-*.ndjson
 *   malformed_observations ← three-minute-obs-malformed-*.ndjson
 *   window_log           ← window-log.json
 *   strategy_version     ← (new — single-row version record)
 */

import {
  pgTable,
  text,
  integer,
  bigint,
  boolean,
  doublePrecision,
  index,
  numeric,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// ── Evaluation events ─────────────────────────────────────────────────────────
// One row per recordEvaluationEvent() call. Replaces NDJSON files on disk.
// Primary key is a natural composite so duplicate fire-and-forget writes
// (e.g. on DB recovery replay) are silently dropped via onConflictDoNothing.
export const evaluationEvents = pgTable(
  "evaluation_events",
  {
    /** Natural PK: "${ticker}@${timestampMs}:${side ?? 'null'}:${outcome}" */
    id:                text("id").primaryKey(),
    timestampMs:       bigint("timestamp_ms",   { mode: "number" }).notNull(),
    easternDate:       text("eastern_date").notNull(),          // YYYY-MM-DD (ET)
    ticker:            text("ticker").notNull(),
    series:            text("series").notNull().default(""),
    secondsLeft:       integer("seconds_left").notNull(),
    source:            text("source").notNull(),                // "websocket" | "rest_fallback" | "startup_prime"
    yesBid:            integer("yes_bid"),
    yesAsk:            integer("yes_ask"),
    noBid:             integer("no_bid"),
    noAsk:             integer("no_ask"),
    yesDerivedAsk:     integer("yes_derived_ask"),
    noDerivedAsk:      integer("no_derived_ask"),
    side:              text("side"),                            // "yes" | "no" | null
    limitCents:        integer("limit_cents"),
    outcome:           text("outcome").notNull(),
    preflightDecision: text("preflight_decision"),
    createdAt:         timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("evaluation_events_ticker_idx").on(table.ticker),
    index("evaluation_events_timestamp_ms_idx").on(table.timestampMs),
    index("evaluation_events_eastern_date_idx").on(table.easternDate),
  ],
);

// ── Order attempts ────────────────────────────────────────────────────────────
// One row per order attempt. `id` = clientOrderId (UUID, stable).
// Written BEFORE the Kalshi API call, updated after the response arrives.

export const orderAttempts = pgTable("order_attempts", {
  id:                     text("id").primaryKey(),
  timestampMs:            bigint("timestamp_ms",             { mode: "number" }).notNull(),
  easternDate:            text("eastern_date").notNull(),               // YYYY-MM-DD (ET)
  ticker:                 text("ticker").notNull(),
  series:                 text("series").notNull().default(""),
  windowCloseTime:        text("window_close_time"),                    // ISO-8601 or null
  side:                   text("side").notNull(),                       // "yes" | "no"
  attemptNumber:          integer("attempt_number"),
  source:                 text("source"),
  triggerPriceCents:      integer("trigger_price_cents"),
  limitPriceCents:        integer("limit_price_cents"),
  requestedContracts:     integer("requested_contracts"),
  requestedNotionalCents: integer("requested_notional_cents"),
  clientOrderId:          text("client_order_id"),
  orderId:                text("order_id"),
  fillCount:              doublePrecision("fill_count"),
  remainingCount:         doublePrecision("remaining_count"),
  contracts:              doublePrecision("contracts"),
  fillPriceCents:         integer("fill_price_cents"),
  notionalDollars:        doublePrecision("notional_dollars"),
  feeDollars:             doublePrecision("fee_dollars"),
  outcome:                text("outcome").default("pending"),            // pending / zero_fill / partial_fill / full_fill
  roundTripMs:            integer("round_trip_ms"),
  // ── Order timeline instrumentation (epoch ms, nullable — added 2026-08-01) ──
  tickReceivedMs:         bigint("tick_received_ms", { mode: "number" }), // WS msg / REST fetch start
  evalStartMs:            bigint("eval_start_ms",    { mode: "number" }), // evaluate() entry
  l2StartMs:              bigint("l2_start_ms",      { mode: "number" }), // pre-flight L2 fetch start
  l2EndMs:                bigint("l2_end_ms",        { mode: "number" }), // pre-flight L2 fetch end
  postStartMs:            bigint("post_start_ms",    { mode: "number" }), // Kalshi POST sent
  ackMs:                  bigint("ack_ms",           { mode: "number" }), // Kalshi response received
  // ── Pre-flight L2 snapshot (from computePreflightDecision, added 2026-08-01) ──
  l2BestAskCents:         integer("l2_best_ask_cents"),                  // executable best ask at preflight
  l2DepthDollars:         doublePrecision("l2_depth_dollars"),           // depth $ at verified limit
  l2DepthContracts:       integer("l2_depth_contracts"),                 // depth contracts at verified limit
  reconciled:             boolean("reconciled"),
  reconcileFailed:        boolean("reconcile_failed"),
  zeroFillDiagnostic:     text("zero_fill_diagnostic"),
  // ── Market settlement outcome (set by outcomeReconciler ~3 min after close) ─
  won:                    boolean("won"),                               // true=won, false=lost, null=unsettled
  settlementResult:       text("settlement_result"),                     // "yes" | "no", durable forward settlement evidence
  settledAtMs:            bigint("settled_at_ms", { mode: "number" }),  // exchange/market settlement time
  // ── Fill price provenance (set at finalisation / reconciliation) ───────────
  fillPriceSource:        text("fill_price_source"),                   // 'actual' | 'limit_fallback' | null
  // ── Fill evidence provenance (controls research-cohort inclusion) ──────────
  // 'historical_attempt_summary' = legacy attempt-level fill only;
  // 'kalshi_fill_api' = exchange order matched and detailed fill chunks stored.
  fillProvenance:         text("fill_provenance"),
  // Only explicitly marked fixtures are excluded from live recovery/reporting.
  // Never infer this from identifiers, dates, or data values.
  isSynthetic:            boolean("is_synthetic").notNull().default(false),
  fixtureNamespace:       text("fixture_namespace"),
  // ── Durable submission audit trail (JSON, nullable; added 2026-08-10) ────────
  // Structured record of where a placeOrder() call stopped and why.
  // Covers every terminal path: guard rejections, final L2 gate failures,
  // pre-POST persistence errors, Kalshi HTTP errors, and accepted orders.
  // Null for rows written before this column was added.
  submissionAudit:        text("submission_audit"),
  createdAt:              timestamp("created_at").defaultNow(),
  updatedAt:              timestamp("updated_at").defaultNow(),
});

// ── Daily budget ──────────────────────────────────────────────────────────────
// One row per Eastern calendar day. Atomically incremented when an order is
// reserved; decremented when the order is released (zero-fill or cap release).

export const dailyBudget = pgTable("daily_budget", {
  easternDate: text("eastern_date").primaryKey(),                       // YYYY-MM-DD
  spentCents:  integer("spent_cents").notNull().default(0),
  updatedAt:   timestamp("updated_at").defaultNow(),
});

// ── Order deduplication ────────────────────────────────────────────────────────
// One row per live dedup slot ("${ticker}-${side}").
// Expires after ORDER_DEDUP_WINDOW_MS (20 min). Deleted on zero-fill / release.

export const orderDedup = pgTable("order_dedup", {
  tickerKey:   text("ticker_key").primaryKey(),                         // "${ticker}-${side}"
  claimedAtMs: bigint("claimed_at_ms", { mode: "number" }).notNull(),
  expiresAtMs: bigint("expires_at_ms", { mode: "number" }).notNull(),
});

/** Candidate-only emergency exit ledger.  It is intentionally separate from
 * both order_attempts and the ETH martingale lifecycle. */
export const eth420CandidateEmergencyReductions = pgTable("eth420_candidate_emergency_reductions", {
  idempotencyKey: text("idempotency_key").primaryKey(),
  candidateOrderId: text("candidate_order_id").notNull(),
  ticker: text("ticker").notNull(),
  candidateKalshiOrderId: text("candidate_kalshi_order_id").notNull(),
  heldSide: text("held_side").notNull(),
  requestedContracts: integer("requested_contracts").notNull(),
  clientOrderId: text("client_order_id").notNull(),
  operatorReason: text("operator_reason").notNull(),
  confirmation: text("confirmation").notNull(),
  expectedExitSide: text("expected_exit_side").notNull(),
  submittedLimitPriceCents: integer("submitted_limit_price_cents"),
  exchangeIndex: integer("exchange_index"),
  acknowledgedAtMs: bigint("acknowledged_at_ms", { mode: "number" }),
  reconciledAtMs: bigint("reconciled_at_ms", { mode: "number" }),
  reconciliationResult: text("reconciliation_result"),
  reconciledFillContracts: integer("reconciled_fill_contracts"),
  reconciledFeeDollars: text("reconciled_fee_dollars"),
  reconciledResidualPosition: integer("reconciled_residual_position"),
  status: text("status").notNull(),
  exitKalshiOrderId: text("exit_kalshi_order_id"),
  failureReason: text("failure_reason"),
  createdAtMs: bigint("created_at_ms", { mode: "number" }).notNull(),
  updatedAtMs: bigint("updated_at_ms", { mode: "number" }).notNull(),
});

// ── Market settlement results ─────────────────────────────────────────────────
// Resolved markets never change their result, so entries live forever.

export const marketResults = pgTable("market_results", {
  ticker:       text("ticker").primaryKey(),
  result:       text("result").notNull(),                               // "yes" | "no"
  resolvedAtMs: bigint("resolved_at_ms", { mode: "number" }),
  createdAt:    timestamp("created_at").defaultNow(),
});

// ── Passive observations (121–180 s window) ───────────────────────────────────
// One row per debounced tick per ticker. `id` = "${ticker}@${timestampMs}".

export const passiveObservations = pgTable("passive_observations", {
  id:                     text("id").primaryKey(),                      // "${ticker}@${timestampMs}"
  timestampMs:            bigint("timestamp_ms",  { mode: "number" }).notNull(),
  isoTimestamp:           text("iso_timestamp").notNull(),
  ticker:                 text("ticker").notNull(),
  series:                 text("series").notNull().default(""),
  asset:                  text("asset").notNull().default("unknown"),   // "BTC" | "ETH" | "unknown"
  windowCloseTime:        text("window_close_time").notNull(),
  windowId:               text("window_id").notNull(),
  secondsLeft:            integer("seconds_left").notNull(),
  yesBid:                 integer("yes_bid"),
  yesAsk:                 integer("yes_ask"),
  noBid:                  integer("no_bid"),
  noAsk:                  integer("no_ask"),
  source:                 text("source").notNull(),
  wsConnected:            boolean("ws_connected").notNull().default(false),
  wsStale:                boolean("ws_stale").notNull().default(false),
  yesQualifies:           boolean("yes_qualifies").notNull().default(false),
  noQualifies:            boolean("no_qualifies").notNull().default(false),
  hypotheticalSide:       text("hypothetical_side"),                    // "yes" | "no" | null
  hypotheticalEntryPrice: integer("hypothetical_entry_price"),
  hypotheticalTier:       text("hypothetical_tier"),
  hypotheticalContracts:  integer("hypothetical_contracts"),
  easternDate:            text("eastern_date").notNull(),
  createdAt:              timestamp("created_at").defaultNow(),
});

// ── Malformed observation records ─────────────────────────────────────────────

export const malformedObservations = pgTable("malformed_observations", {
  id:          text("id").primaryKey(),                                 // "${ticker}@${timestampMs}"
  timestampMs: bigint("timestamp_ms", { mode: "number" }).notNull(),
  ticker:      text("ticker").notNull(),
  secondsLeft: integer("seconds_left").notNull(),
  rawJson:     text("raw_json").notNull(),
  easternDate: text("eastern_date").notNull(),
  createdAt:   timestamp("created_at").defaultNow(),
});

// ── Window activity log ───────────────────────────────────────────────────────
// One row per ticker window. `ticker` is the Kalshi ticker (includes date+time),
// so it is unique per window. Acts as an upsertable active-window cache.

export const windowLogTable = pgTable("window_log", {
  ticker:           text("ticker").primaryKey(),
  series:           text("series").notNull().default(""),
  closeTime:        text("close_time"),
  firstSeenMs:      bigint("first_seen_ms", { mode: "number" }).notNull(),
  entered:          boolean("entered").notNull().default(false),
  inZone:           boolean("in_zone").notNull().default(false),
  yesDerivedAsk:    integer("yes_derived_ask"),
  noDerivedAsk:     integer("no_derived_ask"),
  outcome:          text("outcome").notNull().default("pending"),
  side:             text("side"),
  priceCents:       integer("price_cents"),
  contractsFilled:  doublePrecision("contracts_filled"),
  spentDollars:     doublePrecision("spent_dollars"),
  skipReason:       text("skip_reason"),
  // ── Settlement result (set by outcomeReconciler ~3 min after window close) ─
  settlementResult: text("settlement_result"),                         // "yes" | "no" | null
  updatedAt:        timestamp("updated_at").defaultNow(),
});

// ── Strategy version ──────────────────────────────────────────────────────────
// Single row (id=1). Records the deployed strategy version and deployment time.

export const strategyVersion = pgTable("strategy_version", {
  id:         integer("id").primaryKey().default(1),
  version:    text("version").notNull(),
  deployedAt: timestamp("deployed_at").defaultNow(),
});

// ── Daily guard-outcome counts ────────────────────────────────────────────────
// One row per (eastern_date, series, outcome_key) combination.
// Upserted by the analytics store on every guard-count mutation (debounced).
// Allows full guard-count recovery after a mid-day server restart.
// series: "KXBTC15M" | "KXETH15M" | "combined"
// outcome_key: any GuardOutcomeName ("halted", "dedup", "daily_cap", …)

export const dailyGuardCounts = pgTable("daily_guard_counts", {
  id:          text("id").primaryKey(),             // "${easternDate}:${series}:${outcomeKey}"
  easternDate: text("eastern_date").notNull(),
  series:      text("series").notNull(),
  outcomeKey:  text("outcome_key").notNull(),
  count:       integer("count").notNull().default(0),
  updatedAt:   timestamp("updated_at").defaultNow(),
});

export const preflightDecisions = pgTable("preflight_decisions", {
  /** Composite natural PK: "${ticker}@${timestampMs}:${side}". */
  id:                     text("id").primaryKey(),
  timestampMs:            bigint("timestamp_ms", { mode: "number" }).notNull(),
  easternDate:            text("eastern_date").notNull(),   // YYYY-MM-DD (ET)
  ticker:                 text("ticker").notNull(),
  series:                 text("series").notNull().default(""),
  side:                   text("side").notNull(),           // "yes" | "no"
  secondsLeft:            integer("seconds_left").notNull(),
  quotedBboAsk:           integer("quoted_bbo_ask"),
  bboAgeMs:               integer("bbo_age_ms"),
  bboDerivedLimitCents:   integer("bbo_derived_limit_cents").notNull(),
  executableBestAskCents: integer("executable_best_ask_cents"),
  bboToL2GapCents:        integer("bbo_to_l2_gap_cents"),
  verifiedLimitCents:     integer("verified_limit_cents"),
  depthAtLimitDollars:    doublePrecision("depth_at_limit_dollars").notNull().default(0),
  depthAtLimitContracts:  integer("depth_at_limit_contracts").notNull().default(0),
  intendedContracts:      integer("intended_contracts").notNull().default(0),
  intendedNotionalCents:  integer("intended_notional_cents").notNull().default(0),
  adjustedContracts:      integer("adjusted_contracts").notNull().default(0),
  fillFractionEstimate:   doublePrecision("fill_fraction_estimate").notNull().default(0),
  /** JSON-encoded array of up to 10 near-limit L2 levels. */
  nearLimitLevels:        text("near_limit_levels").notNull().default("[]"),
  l2FetchLatencyMs:       integer("l2_fetch_latency_ms"),
  decision:               text("decision").notNull(),
  marketResult:           text("market_result"),
  createdAt:              timestamp("created_at").defaultNow(),
});

// ── Green Zone research snapshots ─────────────────────────────────────────────
// Immutable entry-time evidence for the passive Green Zone study. Settlement is
// intentionally absent: reports join it in a separate, read-only phase.
export const greenZoneSnapshots = pgTable(
  "green_zone_snapshots",
  {
    id:                         text("id").primaryKey(),
    attemptId:                  text("attempt_id").notNull(),
    ticker:                     text("ticker").notNull(),
    asset:                      text("asset").notNull(),
    side:                       text("side").notNull(),
    submissionTimestampMs:      bigint("submission_timestamp_ms", { mode: "number" }).notNull(),
    executableEntryPriceCents:  integer("executable_entry_price_cents"),
    secondsLeft:                integer("seconds_left"),
    quotedBboAskCents:          integer("quoted_bbo_ask_cents"),
    executableL2AskCents:       integer("executable_l2_ask_cents"),
    signedL2ToBboCents:         integer("signed_l2_to_bbo_cents"),
    bboAgeMs:                   integer("bbo_age_ms"),
    l2DepthDollars:             doublePrecision("l2_depth_dollars"),
    l2DepthContracts:           integer("l2_depth_contracts"),
    preflightTimestampMs:       bigint("preflight_timestamp_ms", { mode: "number" }),
    unavailableReason:          text("unavailable_reason"),
    schemaVersion:              text("schema_version").notNull().default("green-zone-v1"),
    createdAt:                  timestamp("created_at").defaultNow(),
  },
  (table) => [
    uniqueIndex("green_zone_snapshots_attempt_id_idx").on(table.attemptId),
    index("green_zone_snapshots_ticker_idx").on(table.ticker),
  ],
);
// ── Order fills (individual fill events from Kalshi fills API) ────────────────
// One row per fill chunk. A single IOC order may produce multiple fills at
// different prices (e.g. 35¢ × 2, 36¢ × 3). `attempt_id` links back to
// order_attempts.id; `order_id` is the Kalshi order UUID. The volume-weighted
// average of fill_price_cents across all rows for a given order_id equals the
// confirmed_from_fills_api value persisted back on order_attempts.fill_price_cents.
//
// Populated by fillReconciler.ts on every successful reconciliation.
// Backfilled via scripts/backfillOrderFills.ts for historical orders.
//
// Sizing note: contract count is calculated at submission time as
//   floor(betDollars / (limitPriceCents / 100))
// The actual fill price per chunk may be better (lower) than the limit price
// when the order is absorbed across multiple L2 levels.

export const orderFills = pgTable(
  "order_fills",
  {
    /** Legacy PK. New forward rows use "fill:${fillId}" and never rely on array order. */
    id:             text("id").primaryKey(),
    /** Kalshi's immutable fill UUID. Null only for rows retained from before the forward ledger. */
    fillId:         text("fill_id"),
    orderId:        text("order_id").notNull(),
    attemptId:      text("attempt_id"),              // FK → order_attempts.id (null for backfilled rows where client_order_id is unknown)
    ticker:         text("ticker").notNull(),
    side:           text("side").notNull(),           // "yes" | "no"
    fillPriceCents: integer("fill_price_cents").notNull(), // outcome-side cents (e.g. 86 = 86¢); rounded for display only
    contracts:      doublePrecision("contracts").notNull(),
    costDollars:    doublePrecision("cost_dollars").notNull(), // exact cost from Kalshi — never rounded-cents-derived
    feeDollars:     doublePrecision("fee_dollars").notNull(),
    /** Forward-only canonical exchange economics; legacy rows intentionally remain null. */
    exactPriceDollars: numeric("exact_price_dollars"),
    exactCostDollars:  numeric("exact_cost_dollars"),
    exactFeeDollars:   numeric("exact_fee_dollars"),
    canonicalEconomics: boolean("canonical_economics").notNull().default(false),
    fillTimestamp:  text("fill_timestamp"),           // ISO-8601 from Kalshi, if available
    createdAt:      timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("order_fills_order_id_idx").on(table.orderId),
    uniqueIndex("order_fills_fill_id_idx").on(table.fillId),
  ],
);

export const windowTicks = pgTable("window_ticks", {
  /** Composite natural PK: market ticker + wall-clock timestamp. */
  id:            text("id").primaryKey(),               // "${ticker}@${timestampMs}"
  timestampMs:   bigint("timestamp_ms", { mode: "number" }).notNull(),
  easternDate:   text("eastern_date").notNull(),        // YYYY-MM-DD (ET)
  ticker:        text("ticker").notNull(),
  secondsLeft:   integer("seconds_left").notNull(),
  yesBid:        integer("yes_bid"),
  yesAsk:        integer("yes_ask"),
  noBid:         integer("no_bid"),
  noAsk:         integer("no_ask"),
  derivedYesAsk: integer("derived_yes_ask"),
  derivedNoAsk:  integer("derived_no_ask"),
  inZone:        boolean("in_zone").notNull().default(false),
  source:        text("source").notNull().default(""),
  createdAt:     timestamp("created_at").defaultNow(),
});

export const exchangeSweepLog = pgTable("exchange_sweep_log", {
  easternDate:     text("eastern_date").primaryKey(),           // YYYY-MM-DD (ET)
  completedAt:     timestamp("completed_at").notNull().defaultNow(),
  discoveredCount: integer("discovered_count").notNull().default(0),
});

/** Durable, redacted recovery evidence for database outages. */
export const infrastructureIncidents = pgTable("infrastructure_incidents", {
  id:                    text("id").primaryKey(),
  kind:                  text("kind").notNull(),
  startedAtMs:           bigint("started_at_ms", { mode: "number" }).notNull(),
  endedAtMs:             bigint("ended_at_ms", { mode: "number" }),
  reconnectAttempts:     integer("reconnect_attempts").notNull().default(0),
  pendingFinalisations:  integer("pending_finalisations").notNull().default(0),
  pendingDurableWrites:  integer("pending_durable_writes").notNull().default(0),
  entryBlocked:          boolean("entry_blocked").notNull().default(false),
  reconciliationBlocked: boolean("reconciliation_blocked").notNull().default(false),
  protectiveExitBlocked: boolean("protective_exit_blocked").notNull().default(false),
  recoveryOutcome:       text("recovery_outcome").notNull(),
  createdAt:             timestamp("created_at").defaultNow(),
}, (table) => [index("infrastructure_incidents_kind_started_idx").on(table.kind, table.startedAtMs)]);

/** Safe telemetry for bounded retries of authenticated idempotent reads. */
export const kalshiReadNetworkEvents = pgTable("kalshi_read_network_events", {
  id:               text("id").primaryKey(),
  endpointCategory: text("endpoint_category").notNull(),
  errorClass:       text("error_class"),
  elapsedMs:        integer("elapsed_ms").notNull(),
  retryCount:       integer("retry_count").notNull(),
  recoveryOutcome:  text("recovery_outcome").notNull(),
  occurredAt:       timestamp("occurred_at").defaultNow(),
}, (table) => [index("kalshi_read_network_events_occurred_idx").on(table.occurredAt)]);
// ── Coverage-gap incidents ────────────────────────────────────────────────────
// One row per ticker/window (incidentId = "${ticker}@${closeTime}").
// Upserted on every state change so the row always reflects the latest status
// (last-state-wins / ON CONFLICT DO UPDATE).  Survives production redeploys.

export const coverageIncidents = pgTable("coverage_incidents", {
  /** Natural PK: "${ticker}@${closeTime}" — one row per ticker/window. */
  incidentId:          text("incident_id").primaryKey(),
  ticker:              text("ticker").notNull(),
  series:              text("series").notNull().default(""),
  closeTime:           text("close_time").notNull(),
  detectedAtMs:        bigint("detected_at_ms",        { mode: "number" }).notNull(),
  secondsLeftAtDetect: integer("seconds_left_at_detect").notNull(),
  lastUsableQuoteMs:   bigint("last_usable_quote_ms",  { mode: "number" }),
  lastEvaluationMs:    bigint("last_evaluation_ms",    { mode: "number" }),
  lastWsDataMsgMs:     bigint("last_ws_data_msg_ms",   { mode: "number" }),
  lastWsAnyMsgMs:      bigint("last_ws_any_msg_ms",    { mode: "number" }),
  wsConnected:         boolean("ws_connected").notNull().default(false),
  /** JSON-serialized RecoveryAttempt[]. */
  recoveryAttempts:    text("recovery_attempts").notNull().default("[]"),
  /** "unresolved" | "recovered" | "unrecovered_window_closed" */
  status:              text("status").notNull(),
  recoveredAtMs:       bigint("recovered_at_ms",       { mode: "number" }),
  easternDate:         text("eastern_date").notNull(),
  updatedAt:           timestamp("updated_at").defaultNow(),
});

// ── Permanent final-window market-data audit ───────────────────────────────────
// One row per BTC/ETH ticker window. Unlike coverage_incidents (short-lived
// diagnostic detail), this preserves the final data-health classification and
// its complete transition/recovery timeline for later audit.
export const coverageWindowAudits = pgTable("coverage_window_audits", {
  auditId:                 text("audit_id").primaryKey(),
  ticker:                  text("ticker").notNull(),
  series:                  text("series").notNull(),
  closeTime:               text("close_time").notNull(),
  discoveredAtMs:          bigint("discovered_at_ms", { mode: "number" }).notNull(),
  eligibleStartMs:         bigint("eligible_start_ms", { mode: "number" }).notNull(),
  finalWindowStartedAtMs:  bigint("final_window_started_at_ms", { mode: "number" }),
  finalWindowClosedAtMs:   bigint("final_window_closed_at_ms", { mode: "number" }),
  firstUsableQuoteMs:      bigint("first_usable_quote_ms", { mode: "number" }),
  lastUsableQuoteMs:       bigint("last_usable_quote_ms", { mode: "number" }),
  firstEvaluationMs:       bigint("first_evaluation_ms", { mode: "number" }),
  lastEvaluationMs:        bigint("last_evaluation_ms", { mode: "number" }),
  finalWindowUsableQuotes: integer("final_window_usable_quotes").notNull().default(0),
  finalWindowEvaluations:  integer("final_window_evaluations").notNull().default(0),
  /** "OBSERVING" | "HEALTHY" | "DEGRADED_RECOVERED" | "DEGRADED_UNRECOVERED" */
  status:                  text("status").notNull(),
  incidentId:              text("incident_id"),
  /** JSON-serialized coverage state transitions and recovery attempt timeline. */
  transitions:             text("transitions").notNull().default("[]"),
  recoveryAttempts:        text("recovery_attempts").notNull().default("[]"),
  /** "complete" | "restart_continuity_unknown" */
  evidenceCompleteness:    text("evidence_completeness").notNull().default("complete"),
  restartEvidenceUncertain: boolean("restart_evidence_uncertain").notNull().default(false),
  easternDate:             text("eastern_date").notNull(),
  updatedAt:               timestamp("updated_at").defaultNow(),
});



// ── A2 Baseline Reversion shadow-only research ledgers ───────────────────────
// These tables are evidence/idempotency only. They contain no exchange order
// identifiers and cannot authorize, submit, cancel, or modify a Kalshi order.
export const a2BaselineReversionEvidence = pgTable(
  "a2_baseline_reversion_evidence",
  {
    id: text("id").primaryKey(),
    observedAtMs: bigint("observed_at_ms", { mode: "number" }).notNull(),
    sourceOpenTimeMs: bigint("source_open_time_ms", { mode: "number" }).notNull(),
    sourceCloseTimeMs: bigint("source_close_time_ms", { mode: "number" }).notNull(),
    sourceOpen: doublePrecision("source_open").notNull(),
    sourceHigh: doublePrecision("source_high").notNull(),
    sourceLow: doublePrecision("source_low").notNull(),
    sourceClose: doublePrecision("source_close").notNull(),
    sourceDropFraction: doublePrecision("source_drop_fraction"),
    destinationTicker: text("destination_ticker").notNull(),
    destinationOpenTimeMs: bigint("destination_open_time_ms", { mode: "number" }).notNull(),
    destinationCloseTimeMs: bigint("destination_close_time_ms", { mode: "number" }).notNull(),
    yesSemanticsVerified: boolean("yes_semantics_verified").notNull(),
    observedYesAskCents: integer("observed_yes_ask_cents"),
    signal: boolean("signal").notNull(),
    reason: text("reason"),
    stakeCents: integer("stake_cents").notNull(),
    maxEntryPriceCents: integer("max_entry_price_cents").notNull(),
    activeExposureCountObserved: integer("active_exposure_count_observed").notNull(),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("a2_baseline_reversion_evidence_destination_idx").on(table.destinationTicker),
    index("a2_baseline_reversion_evidence_observed_idx").on(table.observedAtMs),
  ],
);

export const a2BaselineReversionShadowClaims = pgTable(
  "a2_baseline_reversion_shadow_claims",
  {
    id: text("id").primaryKey(),
    strategyId: text("strategy_id").notNull(),
    sourceOpenTimeMs: bigint("source_open_time_ms", { mode: "number" }).notNull(),
    sourceCloseTimeMs: bigint("source_close_time_ms", { mode: "number" }).notNull(),
    destinationTicker: text("destination_ticker").notNull(),
    destinationOpenTimeMs: bigint("destination_open_time_ms", { mode: "number" }).notNull(),
    side: text("side").notNull().default("yes"),
    stakeCents: integer("stake_cents").notNull(),
    maxEntryPriceCents: integer("max_entry_price_cents").notNull(),
    observedYesAskCents: integer("observed_yes_ask_cents").notNull(),
    sourceDropFraction: doublePrecision("source_drop_fraction").notNull(),
    state: text("state").notNull().default("shadow_open"),
    settlementResult: text("settlement_result"),
    claimedAtMs: bigint("claimed_at_ms", { mode: "number" }).notNull(),
    settledAtMs: bigint("settled_at_ms", { mode: "number" }),
    updatedAtMs: bigint("updated_at_ms", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [
    uniqueIndex("a2_baseline_reversion_shadow_identity_uq")
      .on(table.sourceOpenTimeMs, table.destinationTicker),
    index("a2_baseline_reversion_shadow_state_idx").on(table.state),
    index("a2_baseline_reversion_shadow_destination_idx").on(table.destinationTicker),
  ],
);

// ── ETH_30_50 isolated strategy tables ───────────────────────────────────────
// These three tables support the isolated ETH_30_50 strategy, which requires:
//   1. Permanent (non-expiring) atomic ticker claims.
//   2. Explicit linkage of entry and exit order IDs to the claimed ticker.
//   3. An append-only position-event ledger for full strategy lifecycle audit.
//
// They are entirely additive — no legacy order_attempts semantics are altered.

// ── Permanent ticker claims ────────────────────────────────────────────────────
// One row per ETH_30_50 ticker claim.  Unlike order_dedup (which expires after
// 20 min), a claim here is permanent and intentional: the strategy may only
// enter a given ticker once.
//
// Atomic claim contract: INSERT ... ON CONFLICT DO NOTHING.  A zero-row return
// means the ticker was already claimed by a prior attempt — caller must abort.
export const eth30TickerClaims = pgTable(
  "eth30_ticker_claims",
  {
    /** Kalshi market ticker — permanent natural PK, one row per market. */
    ticker:      text("ticker").primaryKey(),
    /** ISO-8601 Eastern date of the window (YYYY-MM-DD). */
    easternDate: text("eastern_date").notNull(),
    /** Epoch ms when the claim was first atomically inserted. */
    claimedAtMs: bigint("claimed_at_ms", { mode: "number" }).notNull(),
    /** client_order_id of the initial entry order attempt. */
    entryClientOrderId: text("entry_client_order_id").notNull(),
    createdAt:   timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("eth30_ticker_claims_eastern_date_idx").on(table.easternDate),
    index("eth30_ticker_claims_claimed_at_ms_idx").on(table.claimedAtMs),
  ],
);

// ── ETH_30_50 strategy order links ────────────────────────────────────────────
// One row per order submission (entry or exit) linked to an eth30_ticker_claim.
// Allows a single ticker to have one entry order and one or more exit orders,
// each recorded with their Kalshi order ID and fill outcome once known.
export const eth30StrategyOrders = pgTable(
  "eth30_strategy_orders",
  {
    /** Natural PK: "entry:{ticker}" or "exit:{ticker}:{sequenceNumber}". */
    id:             text("id").primaryKey(),
    ticker:         text("ticker").notNull(),            // FK → eth30_ticker_claims.ticker
    easternDate:    text("eastern_date").notNull(),
    /** "entry" | "exit" */
    role:           text("role").notNull(),
    sequenceNumber: integer("sequence_number").notNull().default(1),
    /** client_order_id (UUID) used in the Kalshi POST body. */
    clientOrderId:  text("client_order_id").notNull(),
    /** Kalshi order UUID returned in the POST response; null until known. */
    kalshiOrderId:  text("kalshi_order_id"),
    side:           text("side").notNull(),              // "yes" | "no"
    limitPriceCents: integer("limit_price_cents").notNull(),
    requestedContracts: doublePrecision("requested_contracts").notNull(),
    /** "pending" | "full_fill" | "partial_fill" | "zero_fill" | "cancelled" | "error" */
    outcome:        text("outcome").notNull().default("pending"),
    filledContracts: doublePrecision("filled_contracts"),
    averageFillPriceCents: integer("average_fill_price_cents"),
    /** Epoch ms when this row was last mutated (for fill/outcome updates). */
    updatedAtMs:    bigint("updated_at_ms", { mode: "number" }).notNull(),
    createdAt:      timestamp("created_at").defaultNow(),
    updatedAt:      timestamp("updated_at").defaultNow(),
  },
  (table) => [
    index("eth30_strategy_orders_ticker_idx").on(table.ticker),
    index("eth30_strategy_orders_eastern_date_idx").on(table.easternDate),
    index("eth30_strategy_orders_client_order_id_idx").on(table.clientOrderId),
  ],
);

// ── ETH_30_50 position events ─────────────────────────────────────────────────
// Append-only ledger of every position change for the ETH_30_50 strategy.
// Covers: entry fills, exit fills, settlement outcomes, and manual corrections.
// Provides a full audit trail for computing the open quantity at any point.
export const eth30PositionEvents = pgTable(
  "eth30_position_events",
  {
    /** Natural PK: "${ticker}:${eventType}:${timestampMs}". */
    id:             text("id").primaryKey(),
    ticker:         text("ticker").notNull(),            // FK → eth30_ticker_claims.ticker
    easternDate:    text("eastern_date").notNull(),
    /** "entry_fill" | "exit_fill" | "settlement" | "correction" */
    eventType:      text("event_type").notNull(),
    /** Signed contract delta: positive = contracts acquired, negative = contracts sold. */
    contractsDelta: doublePrecision("contracts_delta").notNull(),
    /** Running net contracts held after this event (computed by the writer). */
    contractsAfter: doublePrecision("contracts_after").notNull(),
    /** Entry or exit order ID (eth30_strategy_orders.id) that triggered this event; null for settlement/correction. */
    strategyOrderId: text("strategy_order_id"),
    /** Kalshi fill price in cents for this specific fill chunk. */
    fillPriceCents:  integer("fill_price_cents"),
    /** Kalshi exchange fee for this fill chunk, in cents (rounded). Null for legacy rows pre-dating fee capture, and for settlement events. */
    feeCents:        integer("fee_cents"),
    /** Settlement result "yes" | "no"; null for non-settlement events. */
    settlementResult: text("settlement_result"),
    /** Free-form note for correction events or extra context. */
    note:           text("note"),
    /** Epoch ms when the underlying exchange event occurred. */
    occurredAtMs:   bigint("occurred_at_ms", { mode: "number" }).notNull(),
    createdAt:      timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("eth30_position_events_ticker_idx").on(table.ticker),
    index("eth30_position_events_eastern_date_idx").on(table.easternDate),
    index("eth30_position_events_occurred_at_ms_idx").on(table.occurredAtMs),
  ],
);

// ── ETH_30_50 passive shadow telemetry ───────────────────────────────────────
// These research-only ledgers deliberately live apart from claims, orders, and
// position mutation. They may describe a hypothetical protective signal but can
// never authorize, replace, resize, or cancel an exchange order.
export const eth30ShadowObservations = pgTable(
  "eth30_shadow_observations",
  {
    id:           text("id").primaryKey(),
    ticker:       text("ticker").notNull(),
    observedAtMs: bigint("observed_at_ms", { mode: "number" }).notNull(),
    payloadJson:  text("payload_json").notNull(),
    createdAt:    timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("eth30_shadow_observations_ticker_time_idx").on(table.ticker, table.observedAtMs),
  ],
);

export const eth30ShadowEvents = pgTable(
  "eth30_shadow_events",
  {
    id:           text("id").primaryKey(),
    ticker:       text("ticker").notNull(),
    signal:       text("signal").notNull(),
    triggeredAtMs: bigint("triggered_at_ms", { mode: "number" }).notNull(),
    payloadJson:  text("payload_json").notNull(),
    createdAt:    timestamp("created_at").defaultNow(),
    updatedAt:    timestamp("updated_at").defaultNow(),
  },
  (table) => [
    index("eth30_shadow_events_ticker_time_idx").on(table.ticker, table.triggeredAtMs),
  ],
);

// ── ETH_30_50 decision events ─────────────────────────────────────────────────
// Append-only decision/skip evidence ledger for the ETH_30_50 strategy.
// One row per notable decision inside an eligible opening window: gate blocks,
// no-executable-candidate skips, claim conflicts, entry outcomes, and the first
// moment the resting 50¢ target became executable (best bid ≥ 50¢).
// Rows are audit evidence only — they never drive trading behavior.
export const eth30DecisionEvents = pgTable(
  "eth30_decision_events",
  {
    /** Natural PK provided by the writer; once-only events use a stable id. */
    id:           text("id").primaryKey(),
    ticker:       text("ticker").notNull(),
    easternDate:  text("eastern_date").notNull(),
    /**
     * "gate_blocked" | "no_executable_candidate" | "claim_conflict" |
     * "entry_placed" | "entry_zero_fill" | "entry_error" |
     * "target_first_executable"
     */
    decision:     text("decision").notNull(),
    side:         text("side"),                 // "yes" | "no" | null
    priceCents:   integer("price_cents"),
    contracts:    integer("contracts"),
    note:         text("note"),
    occurredAtMs: bigint("occurred_at_ms", { mode: "number" }).notNull(),
    createdAt:    timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("eth30_decision_events_ticker_idx").on(table.ticker),
    index("eth30_decision_events_eastern_date_idx").on(table.easternDate),
    index("eth30_decision_events_occurred_at_ms_idx").on(table.occurredAtMs),
  ],
);

// ── ETH 21–25¢ → 50¢ prospective passive cohort ─────────────────────────────
// This is a research-only ledger. It is intentionally not linked to live ETH
// claims or orders; one row represents one hypothetical $10 opportunity.
export const eth2125ProspectiveCohort = pgTable(
  "eth2125_prospective_cohort",
  {
    ticker:              text("ticker").primaryKey(),
    cohortStartMs:       bigint("cohort_start_ms", { mode: "number" }).notNull(),
    easternDate:         text("eastern_date").notNull(),
    observedAtMs:        bigint("observed_at_ms", { mode: "number" }).notNull(),
    side:                text("side").notNull(),
    entryPriceCents:     integer("entry_price_cents").notNull(),
    contracts:           integer("contracts").notNull(),
    entryCostCents:      integer("entry_cost_cents").notNull(),
    estimatedEntryFeeCents: integer("estimated_entry_fee_cents").notNull(),
    firstTargetAtMs:     bigint("first_target_at_ms", { mode: "number" }),
    firstTargetBidCents: integer("first_target_bid_cents"),
    createdAt:           timestamp("created_at").defaultNow(),
    updatedAt:           timestamp("updated_at").defaultNow(),
  },
  (table) => [
    index("eth2125_prospective_observed_idx").on(table.observedAtMs),
    index("eth2125_prospective_date_idx").on(table.easternDate),
  ],
);

// ── SOL_30_50 isolated strategy tables ───────────────────────────────────────
// Mirror of the ETH_30_50 tables for the SOL_30_50 strategy.
// Four tables: ticker claims, strategy orders, position events, decision events.
// Naming convention: sol30_* (SQL), sol30* (TS export).
// SOL is disabled by configuration; these tables are schema-only.

export const sol30TickerClaims = pgTable(
  "sol30_ticker_claims",
  {
    /** Kalshi market ticker — permanent natural PK, one row per market. */
    ticker:      text("ticker").primaryKey(),
    /** ISO-8601 Eastern date of the window (YYYY-MM-DD). */
    easternDate: text("eastern_date").notNull(),
    /** Epoch ms when the claim was first atomically inserted. */
    claimedAtMs: bigint("claimed_at_ms", { mode: "number" }).notNull(),
    /** client_order_id of the initial entry order attempt. */
    entryClientOrderId: text("entry_client_order_id").notNull(),
    createdAt:   timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("sol30_ticker_claims_eastern_date_idx").on(table.easternDate),
    index("sol30_ticker_claims_claimed_at_ms_idx").on(table.claimedAtMs),
  ],
);

export const sol30StrategyOrders = pgTable(
  "sol30_strategy_orders",
  {
    /** Natural PK: "entry:{ticker}" or "exit:{ticker}:{sequenceNumber}". */
    id:             text("id").primaryKey(),
    ticker:         text("ticker").notNull(),
    easternDate:    text("eastern_date").notNull(),
    /** "entry" | "exit" */
    role:           text("role").notNull(),
    sequenceNumber: integer("sequence_number").notNull().default(1),
    /** client_order_id (UUID) used in the Kalshi POST body. */
    clientOrderId:  text("client_order_id").notNull(),
    /** Kalshi order UUID returned in the POST response; null until known. */
    kalshiOrderId:  text("kalshi_order_id"),
    side:           text("side").notNull(),
    limitPriceCents: integer("limit_price_cents").notNull(),
    requestedContracts: doublePrecision("requested_contracts").notNull(),
    outcome:        text("outcome").notNull().default("pending"),
    filledContracts: doublePrecision("filled_contracts"),
    averageFillPriceCents: integer("average_fill_price_cents"),
    updatedAtMs:    bigint("updated_at_ms", { mode: "number" }).notNull(),
    createdAt:      timestamp("created_at").defaultNow(),
    updatedAt:      timestamp("updated_at").defaultNow(),
  },
  (table) => [
    index("sol30_strategy_orders_ticker_idx").on(table.ticker),
    index("sol30_strategy_orders_eastern_date_idx").on(table.easternDate),
    index("sol30_strategy_orders_client_order_id_idx").on(table.clientOrderId),
  ],
);

export const sol30PositionEvents = pgTable(
  "sol30_position_events",
  {
    /** Natural PK: "${ticker}:${eventType}:${timestampMs}". */
    id:             text("id").primaryKey(),
    ticker:         text("ticker").notNull(),
    easternDate:    text("eastern_date").notNull(),
    /** "entry_fill" | "exit_fill" | "settlement" | "correction" */
    eventType:      text("event_type").notNull(),
    contractsDelta: doublePrecision("contracts_delta").notNull(),
    contractsAfter: doublePrecision("contracts_after").notNull(),
    strategyOrderId: text("strategy_order_id"),
    fillPriceCents:  integer("fill_price_cents"),
    feeCents:        integer("fee_cents"),
    settlementResult: text("settlement_result"),
    note:           text("note"),
    occurredAtMs:   bigint("occurred_at_ms", { mode: "number" }).notNull(),
    createdAt:      timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("sol30_position_events_ticker_idx").on(table.ticker),
    index("sol30_position_events_eastern_date_idx").on(table.easternDate),
    index("sol30_position_events_occurred_at_ms_idx").on(table.occurredAtMs),
  ],
);

export const sol30DecisionEvents = pgTable(
  "sol30_decision_events",
  {
    /** Natural PK provided by the writer; once-only events use a stable id. */
    id:           text("id").primaryKey(),
    ticker:       text("ticker").notNull(),
    easternDate:  text("eastern_date").notNull(),
    decision:     text("decision").notNull(),
    side:         text("side"),
    priceCents:   integer("price_cents"),
    contracts:    integer("contracts"),
    note:         text("note"),
    occurredAtMs: bigint("occurred_at_ms", { mode: "number" }).notNull(),
    createdAt:    timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("sol30_decision_events_ticker_idx").on(table.ticker),
    index("sol30_decision_events_eastern_date_idx").on(table.easternDate),
    index("sol30_decision_events_occurred_at_ms_idx").on(table.occurredAtMs),
  ],
);

export const protectiveExitAttempts = pgTable(
  "protective_exit_attempts",
  {
    id:                       text("id").primaryKey(),
    timestampMs:              bigint("timestamp_ms", { mode: "number" }).notNull(),
    ticker:                   text("ticker").notNull(),
    asset:                    text("asset").notNull(),
    heldSide:                 text("held_side").notNull(),
    linkedEntryId:            text("linked_entry_id"),
    originalEntryPriceCents:  integer("original_entry_price_cents"),
    originalFillQuantity:     integer("original_fill_quantity"),
    confirmedPositionBefore:  integer("confirmed_position_before").notNull(),
    triggerCents:             integer("trigger_cents").notNull(),
    executableBidCents:       integer("executable_bid_cents"),
    bidDepthContracts:        integer("bid_depth_contracts"),
    quoteTimestampMs:         bigint("quote_timestamp_ms", { mode: "number" }),
    quoteAgeMs:               integer("quote_age_ms"),
    requestedContracts:       integer("requested_contracts"),
    limitPriceCents:          integer("limit_price_cents").notNull(),
    timeInForce:              text("time_in_force").notNull(),
    postInitiated:            boolean("post_initiated").notNull().default(false),
    responseReceived:         boolean("response_received").notNull().default(false),
    kalshiOrderId:            text("kalshi_order_id"),
    fillQuantity:             integer("fill_quantity"),
    averageExitPriceCents:    integer("average_exit_price_cents"),
    remainingPosition:        integer("remaining_position"),
    outcome:                  text("outcome").notNull(),
    reason:                   text("reason"),
    rawBook:                  text("raw_book"),
    createdAt:                timestamp("created_at").defaultNow(),
    updatedAt:                timestamp("updated_at").defaultNow(),
  },
  (table) => [
    index("protective_exit_attempts_ticker_idx").on(table.ticker),
    index("protective_exit_attempts_timestamp_idx").on(table.timestampMs),
  ],
);

// ── Target-liquidity snapshots (ETH/SOL 30–50 observability) ─────────────────
// One row per throttled observation captured while a strategy's 50¢ GTC
// target rests AND the owned-side best bid is at/above the target price.
// Persists the executable bid levels (price + contracts) at/above the target,
// the durable identity/size of the resting target, and the exchange-reported
// order status, so post-hoc analysis can distinguish "insufficient queue
// depth" from "sufficient depth while the target stayed unfilled" (an
// execution/order-management defect). Pure observability — rows never drive
// trading behavior.
export const targetLiquiditySnapshots = pgTable(
  "target_liquidity_snapshots",
  {
    /** "${strategy}:${ticker}:${capturedAtMs}" — natural PK. */
    id:                       text("id").primaryKey(),
    /** Owning strategy: "ETH_30_50" | "SOL_30_50". */
    strategy:                 text("strategy").notNull(),
    ticker:                   text("ticker").notNull(),
    easternDate:              text("eastern_date").notNull(),
    /** Held outcome side whose buyers must absorb the target ask. */
    side:                     text("side").notNull(),           // "yes" | "no"
    /** Durable strategy-order row id of the resting target (e.g. "exit:T:1"). */
    targetOrderDbId:          text("target_order_db_id"),
    targetKalshiOrderId:      text("target_kalshi_order_id"),
    /** Epoch ms the target order row was created (start of target-active interval). */
    targetPlacedAtMs:         bigint("target_placed_at_ms", { mode: "number" }),
    /** Exchange-reported order status at snapshot time; null when the fetch failed. */
    orderStatus:              text("order_status"),
    /** Contracts still resting on the target per durable rows. */
    restingContracts:         integer("resting_contracts"),
    /** BBO owned-side bid that triggered the snapshot. */
    observedBidCents:         integer("observed_bid_cents"),
    /** JSON array of { priceCents, contractsApprox } at/above the target. */
    bidLevelsJson:            text("bid_levels_json").notNull().default("[]"),
    /** Total contracts across those levels. */
    contractsAtOrAboveTarget: integer("contracts_at_or_above_target").notNull().default(0),
    /** Non-null when the orderbook fetch failed (depth fields are empty/zero). */
    bookError:                text("book_error"),
    capturedAtMs:             bigint("captured_at_ms", { mode: "number" }).notNull(),
    createdAt:                timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("target_liquidity_snapshots_ticker_idx").on(table.ticker),
    index("target_liquidity_snapshots_strategy_idx").on(table.strategy),
    index("target_liquidity_snapshots_captured_at_ms_idx").on(table.capturedAtMs),
  ],
);
