import {
  bigint,
  boolean,
  doublePrecision,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";

/** Passive research records. These tables are not part of the trading order path. */
export const recoverabilitySpotTicks = pgTable("recoverability_spot_ticks", {
  id:          text("id").primaryKey(),
  timestampMs: bigint("timestamp_ms", { mode: "number" }).notNull(),
  asset:       text("asset").notNull(),
  provider:    text("provider").notNull(),
  rawSymbol:   text("raw_symbol").notNull(),
  bid:         doublePrecision("bid"),
  ask:         doublePrecision("ask"),
  midpoint:    doublePrecision("midpoint"),
  receiptMs:   bigint("receipt_ms", { mode: "number" }).notNull(),
  isProxy:     boolean("is_proxy").notNull(),
  methodology: text("methodology").notNull(),
  easternDate: text("eastern_date").notNull(),
  createdAt:   timestamp("created_at").defaultNow(),
});

export const recoverabilityObservations = pgTable("recoverability_observations", {
  id:                        text("id").primaryKey(),
  timestampMs:               bigint("timestamp_ms", { mode: "number" }).notNull(),
  ticker:                    text("ticker").notNull(),
  series:                    text("series").notNull(),
  asset:                     text("asset").notNull(),
  windowId:                  text("window_id").notNull(),
  observationNumberInWindow: integer("observation_number_in_window").notNull(),
  secondsLeft:               integer("seconds_left"),
  yesBid:                    integer("yes_bid"),
  yesAsk:                    integer("yes_ask"),
  noBid:                     integer("no_bid"),
  noAsk:                     integer("no_ask"),
  selectedSide:              text("selected_side"),
  selectedPriceCents:        integer("selected_price_cents"),
  selectedImplied:           doublePrecision("selected_implied"),
  floorStrike:               doublePrecision("floor_strike"),
  rulesPrimary:              text("rules_primary"),
  rulesSecondary:            text("rules_secondary"),
  rulesHash:                 text("rules_hash").notNull(),
  comparisonOperator:        text("comparison_operator"),
  settlementSource:          text("settlement_source"),
  spotMidpoint:              doublePrecision("spot_midpoint"),
  spotAgeMs:                 bigint("spot_age_ms", { mode: "number" }),
  spotProvider:              text("spot_provider"),
  spotRawSymbol:             text("spot_raw_symbol"),
  spotIsProxy:               boolean("spot_is_proxy"),
  qualityFlags:              text("quality_flags").notNull().default("[]"),
  easternDate:               text("eastern_date").notNull(),
  createdAt:                 timestamp("created_at").defaultNow(),
});

export const recoverabilityMarketOutcomes = pgTable("recoverability_market_outcomes", {
  ticker:                   text("ticker").primaryKey(),
  result:                   text("result").notNull(),
  finalizedAtMs:            bigint("finalized_at_ms", { mode: "number" }).notNull(),
  reportedSettlementValue:  doublePrecision("reported_settlement_value"),
  rawJson:                  text("raw_json").notNull(),
  easternDate:              text("eastern_date").notNull(),
  createdAt:                timestamp("created_at").defaultNow(),
});

export const recoverabilityLabels = pgTable("recoverability_labels", {
  id:                                      text("id").primaryKey(),
  observationId:                           text("observation_id").notNull(),
  ticker:                                  text("ticker").notNull(),
  generatedAtMs:                           bigint("generated_at_ms", { mode: "number" }).notNull(),
  labelVersion:                            text("label_version").notNull(),
  proxyTouchedOrCrossedStrikeAfter:        boolean("proxy_touched_or_crossed_strike_after"),
  proxyFinishedOppositeSideAtClose:        boolean("proxy_finished_opposite_side_at_close"),
  estimated60SecondProxyAverage:           doublePrecision("estimated_60_second_proxy_average"),
  officialSettlementResult:                text("official_settlement_result").notNull(),
  easternDate:                             text("eastern_date").notNull(),
  createdAt:                               timestamp("created_at").defaultNow(),
});

/**
 * Immutable, passive snapshots of preflight decisions that were skipped because
 * the BBO-to-L2 gap was stale. The complete research payload is retained as
 * JSONB so later analysis never loses fields when the calculator evolves.
 */
export const staleGapCounterfactualCaptures = pgTable("stale_gap_counterfactual_captures", {
  captureId:    text("capture_id").primaryKey(),
  timestampMs:  bigint("timestamp_ms", { mode: "number" }).notNull(),
  easternDate:  text("eastern_date").notNull(),
  ticker:       text("ticker").notNull(),
  series:       text("series").notNull(),
  side:         text("side").notNull(),
  payload:      jsonb("payload").notNull(),
  createdAt:    timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Phase 4B raw passive research entities. They are separate from all trading tables. */
export const phase4bMarketIntervals = pgTable("phase4b_market_intervals", {
  marketId: text("market_id").primaryKey(),
  ticker: text("ticker").notNull(),
  series: text("series").notNull(),
  asset: text("asset").notNull(),
  intervalStartMs: bigint("interval_start_ms", { mode: "number" }),
  intervalEndMs: bigint("interval_end_ms", { mode: "number" }),
  windowCloseMs: bigint("window_close_ms", { mode: "number" }).notNull(),
  metadataCapturedAtMs: bigint("metadata_captured_at_ms", { mode: "number" }).notNull(),
  schemaVersion: text("schema_version").notNull(),
  metadataVersion: text("metadata_version").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const phase4bDecisionSnapshots = pgTable("phase4b_decision_snapshots", {
  snapshotId: text("snapshot_id").primaryKey(),
  marketId: text("market_id").notNull(),
  capturedAtMs: bigint("captured_at_ms", { mode: "number" }).notNull(),
  secondsLeft: integer("seconds_left").notNull(),
  candidateSide: text("candidate_side").notNull(),
  source: text("source").notNull(),
  payload: jsonb("payload").notNull(),
  schemaVersion: text("schema_version").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const phase4bBookSnapshots = pgTable("phase4b_book_snapshots", {
  id: text("id").primaryKey(),
  snapshotId: text("snapshot_id").notNull(),
  marketId: text("market_id").notNull(),
  capturedAtMs: bigint("captured_at_ms", { mode: "number" }).notNull(),
  side: text("side").notNull(),
  payload: jsonb("payload").notNull(),
  schemaVersion: text("schema_version").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const phase4bReferenceObservations = pgTable("phase4b_reference_observations", {
  id: text("id").primaryKey(),
  snapshotId: text("snapshot_id").notNull(),
  marketId: text("market_id").notNull(),
  capturedAtMs: bigint("captured_at_ms", { mode: "number" }).notNull(),
  asset: text("asset").notNull(),
  source: text("source").notNull(),
  payload: jsonb("payload").notNull(),
  schemaVersion: text("schema_version").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const phase4bMarketOutcomes = pgTable("phase4b_market_outcomes", {
  marketId: text("market_id").primaryKey(),
  result: text("result"),
  settlementTimestampMs: bigint("settlement_timestamp_ms", { mode: "number" }),
  reconciledAtMs: bigint("reconciled_at_ms", { mode: "number" }).notNull(),
  settlementStatus: text("settlement_status").notNull(),
  schemaVersion: text("schema_version").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Append-only passive hypothesis observations; never consulted by trading code. */
export const phase4bProspectiveSimulations = pgTable("phase4b_prospective_simulations", {
  id: text("id").primaryKey(),
  snapshotId: text("snapshot_id").notNull(),
  hypothesisVersion: text("hypothesis_version").notNull(),
  qualification: text("qualification").notNull(),
  ticker: text("ticker").notNull(),
  capturedAtMs: bigint("captured_at_ms", { mode: "number" }).notNull(),
  payload: jsonb("payload").notNull(),
  schemaVersion: text("schema_version").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Per-ledger cursor for the compact BTC/ETH research worker. This is isolated
 * research metadata: it is never read by an execution, order, or risk path.
 */
export const phase4bCompactLedgerCheckpoints = pgTable("phase4b_compact_ledger_checkpoints", {
  ledgerPath: text("ledger_path").primaryKey(),
  device: text("device"),
  inode: text("inode"),
  byteOffset: bigint("byte_offset", { mode: "number" }).notNull().default(0),
  lastRecordId: text("last_record_id"),
  lastRecordAtMs: bigint("last_record_at_ms", { mode: "number" }),
  status: text("status").notNull().default("new"),
  lastReason: text("last_reason"),
  rejectedCount: bigint("rejected_count", { mode: "number" }).notNull().default(0),
  malformedCount: bigint("malformed_count", { mode: "number" }).notNull().default(0),
  writeFailureCount: bigint("write_failure_count", { mode: "number" }).notNull().default(0),
  lostRecordCount: bigint("lost_record_count", { mode: "number" }).notNull().default(0),
  rotationCount: bigint("rotation_count", { mode: "number" }).notNull().default(0),
  truncationCount: bigint("truncation_count", { mode: "number" }).notNull().default(0),
  updatedAtMs: bigint("updated_at_ms", { mode: "number" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Immutable passive-only research program registry; never read by execution code. */
export const passiveExperimentRegistry = pgTable("passive_experiment_registry", {
  experimentVersion: text("experiment_version").primaryKey(),
  program: text("program").notNull(),
  name: text("name").notNull(),
  config: jsonb("config").notNull(),
  schemaVersion: text("schema_version").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Frozen feature vector and availability state at a candidate boundary. */
export const passiveExperimentCaptures = pgTable("passive_experiment_captures", {
  captureId: text("capture_id").primaryKey(),
  experimentVersion: text("experiment_version").notNull(),
  snapshotId: text("snapshot_id").notNull(),
  marketId: text("market_id").notNull(),
  ticker: text("ticker").notNull(),
  asset: text("asset").notNull(),
  capturedAtMs: bigint("captured_at_ms", { mode: "number" }).notNull(),
  qualification: text("qualification").notNull(),
  payload: jsonb("payload").notNull(),
  schemaVersion: text("schema_version").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Later market labels are separate from immutable candidate captures. */
export const passiveExperimentSettlements = pgTable("passive_experiment_settlements", {
  experimentVersion: text("experiment_version").notNull(),
  marketId: text("market_id").notNull(),
  result: text("result"),
  settlementTimestampMs: bigint("settlement_timestamp_ms", { mode: "number" }),
  reconciledAtMs: bigint("reconciled_at_ms", { mode: "number" }).notNull(),
  settlementStatus: text("settlement_status").notNull(),
  schemaVersion: text("schema_version").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({ pk: primaryKey({ columns: [table.experimentVersion, table.marketId] }) }));

export const insertRecoverabilitySpotTickSchema = createInsertSchema(recoverabilitySpotTicks);
export const insertRecoverabilityObservationSchema = createInsertSchema(recoverabilityObservations);
export const insertRecoverabilityMarketOutcomeSchema = createInsertSchema(recoverabilityMarketOutcomes);
export const insertRecoverabilityLabelSchema = createInsertSchema(recoverabilityLabels);
export const insertStaleGapCounterfactualCaptureSchema = createInsertSchema(staleGapCounterfactualCaptures);
export const insertPhase4bMarketIntervalSchema = createInsertSchema(phase4bMarketIntervals);
export const insertPhase4bDecisionSnapshotSchema = createInsertSchema(phase4bDecisionSnapshots);
export const insertPhase4bBookSnapshotSchema = createInsertSchema(phase4bBookSnapshots);
export const insertPhase4bReferenceObservationSchema = createInsertSchema(phase4bReferenceObservations);
export const insertPhase4bMarketOutcomeSchema = createInsertSchema(phase4bMarketOutcomes);
export const insertPhase4bProspectiveSimulationSchema = createInsertSchema(phase4bProspectiveSimulations);
export const insertPhase4bCompactLedgerCheckpointSchema = createInsertSchema(phase4bCompactLedgerCheckpoints);
export const insertPassiveExperimentRegistrySchema = createInsertSchema(passiveExperimentRegistry);
export const insertPassiveExperimentCaptureSchema = createInsertSchema(passiveExperimentCaptures);
export const insertPassiveExperimentSettlementSchema = createInsertSchema(passiveExperimentSettlements);

export type InsertRecoverabilitySpotTick = typeof recoverabilitySpotTicks.$inferInsert;
export type InsertRecoverabilityObservation = typeof recoverabilityObservations.$inferInsert;
export type InsertRecoverabilityMarketOutcome = typeof recoverabilityMarketOutcomes.$inferInsert;
export type InsertRecoverabilityLabel = typeof recoverabilityLabels.$inferInsert;
export type InsertStaleGapCounterfactualCapture = typeof staleGapCounterfactualCaptures.$inferInsert;
export type InsertPhase4bMarketInterval = typeof phase4bMarketIntervals.$inferInsert;
export type InsertPhase4bDecisionSnapshot = typeof phase4bDecisionSnapshots.$inferInsert;
export type InsertPhase4bBookSnapshot = typeof phase4bBookSnapshots.$inferInsert;
export type InsertPhase4bReferenceObservation = typeof phase4bReferenceObservations.$inferInsert;
export type InsertPhase4bMarketOutcome = typeof phase4bMarketOutcomes.$inferInsert;
export type InsertPhase4bProspectiveSimulation = typeof phase4bProspectiveSimulations.$inferInsert;
export type InsertPhase4bCompactLedgerCheckpoint = typeof phase4bCompactLedgerCheckpoints.$inferInsert;
export type InsertPassiveExperimentRegistry = typeof passiveExperimentRegistry.$inferInsert;
export type InsertPassiveExperimentCapture = typeof passiveExperimentCaptures.$inferInsert;
export type InsertPassiveExperimentSettlement = typeof passiveExperimentSettlements.$inferInsert;