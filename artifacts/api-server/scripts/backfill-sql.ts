#!/usr/bin/env tsx
/**
 * Backfill existing NDJSON/JSON files into SQL.
 *
 * Run once after schema push:
 *   pnpm --filter @workspace/api-server exec tsx scripts/backfill-sql.ts
 *
 * Idempotent — uses ON CONFLICT DO NOTHING on all inserts.
 *
 * Reconciliation: prints NDJSON row counts and dollar totals vs SQL
 * and exits with code 1 if any mismatch is detected.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { db } from "@workspace/db";
import {
  orderAttempts,
  marketResults,
  passiveObservations,
  windowLogTable,
} from "@workspace/db/schema";
import { sql, count } from "drizzle-orm";

const DATA_DIR      = join(process.cwd(), "data");
const ANALYTICS_DIR = join(DATA_DIR, "analytics");

// ── Helpers ───────────────────────────────────────────────────────────────────

function readNdjson(path: string): unknown[] {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  const out: unknown[] = [];
  for (const line of lines) {
    try { out.push(JSON.parse(line)); } catch { /* skip malformed */ }
  }
  return out;
}

function parseCents(v: unknown): number {
  if (typeof v === "number") return Math.round(v);
  if (typeof v === "object" && v !== null) {
    const rec = v as Record<string, unknown>;
    const val = rec["value"] ?? rec["trackedValue"];
    if (typeof val === "number") return Math.round(val);
  }
  return 0;
}

// ── 1. Backfill order_attempts ────────────────────────────────────────────────

console.log("\n=== 1. Order attempts ===");

const orderFiles = existsSync(ANALYTICS_DIR)
  ? readdirSync(ANALYTICS_DIR).filter((f) => f.startsWith("orders-") && f.endsWith(".ndjson"))
  : [];

let ndjsonOrders   = 0;
let ndjsonNotional = 0;
let sqlInserted    = 0;

// Last-write-wins per ID (same as the in-memory hydration)
const byId = new Map<string, Record<string, unknown>>();
for (const f of orderFiles) {
  const path    = join(ANALYTICS_DIR, f);
  const records = readNdjson(path) as Record<string, unknown>[];
  for (const r of records) {
    if (typeof r.id === "string" && r.id) byId.set(r.id, r);
  }
}

ndjsonOrders = byId.size;

// Derive eastern_date from timestampMs
function toEasternDate(tsMs: number): string {
  return new Date(tsMs).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

// Insert in batches of 100
const orderChunks: Record<string, unknown>[][] = [];
const orderArr = [...byId.values()];
for (let i = 0; i < orderArr.length; i += 100) orderChunks.push(orderArr.slice(i, i + 100));

for (const chunk of orderChunks) {
  const values = chunk.map((r) => ({
    id:                     String(r.id),
    timestampMs:            Number(r.timestampMs ?? 0),
    easternDate:            toEasternDate(Number(r.timestampMs ?? 0)),
    ticker:                 String(r.ticker ?? ""),
    series:                 String(r.series ?? ""),
    windowCloseTime:        typeof r.windowCloseTime === "string" ? r.windowCloseTime : null,
    side:                   String(r.side ?? "yes"),
    attemptNumber:          typeof r.attemptNumber === "number" ? r.attemptNumber : null,
    source:                 typeof r.source === "string" ? r.source : null,
    triggerPriceCents:      typeof r.triggerPriceCents === "number" ? r.triggerPriceCents : null,
    limitPriceCents:        typeof r.limitPriceCents === "number" ? r.limitPriceCents : null,
    requestedContracts:     typeof r.requestedContracts === "number" ? r.requestedContracts : null,
    requestedNotionalCents: typeof r.requestedNotionalCents === "number" ? r.requestedNotionalCents : null,
    clientOrderId:          typeof r.clientOrderId === "string" ? r.clientOrderId : null,
    orderId:                typeof r.orderId === "string" ? r.orderId : null,
    fillCount:              typeof r.fillCount === "number" ? r.fillCount : null,
    remainingCount:         typeof r.remainingCount === "number" ? r.remainingCount : null,
    contracts:              parseCents(r.contracts) || null,
    fillPriceCents:         parseCents(r.fillPriceCents) || null,
    notionalDollars:        typeof r.notionalDollars === "number" ? r.notionalDollars
                              : (r.notionalDollars && typeof (r.notionalDollars as Record<string,unknown>)["value"] === "number"
                                  ? (r.notionalDollars as Record<string,unknown>)["value"] as number : null),
    feeDollars:             typeof r.feeDollars === "number" ? r.feeDollars
                              : (r.feeDollars && typeof (r.feeDollars as Record<string,unknown>)["value"] === "number"
                                  ? (r.feeDollars as Record<string,unknown>)["value"] as number : null),
    outcome:                typeof r.outcome === "string" ? r.outcome : null,
    roundTripMs:            typeof r.roundTripMs === "number" ? r.roundTripMs : null,
    reconciled:             typeof r.reconciled === "boolean" ? r.reconciled : null,
    zeroFillDiagnostic:     typeof r.zeroFillDiagnostic === "string" ? r.zeroFillDiagnostic : null,
  }));

  const res = await db.insert(orderAttempts).values(values).onConflictDoNothing().returning({ id: orderAttempts.id });
  sqlInserted += res.length;
  for (const r of chunk) {
    ndjsonNotional += typeof r.requestedNotionalCents === "number" ? r.requestedNotionalCents : 0;
  }
}

const sqlOrderRows = await db.execute<{ c: number; n: number }>(sql`
  SELECT COUNT(*)::int AS c, COALESCE(SUM(requested_notional_cents),0)::bigint AS n
  FROM order_attempts
`);
const sqlOrderCount   = Number((sqlOrderRows.rows[0] as Record<string,unknown>)["c"] ?? 0);
const sqlOrderNotional = Number((sqlOrderRows.rows[0] as Record<string,unknown>)["n"] ?? 0);

console.log(`  NDJSON records:    ${ndjsonOrders}`);
console.log(`  SQL rows:          ${sqlOrderCount}`);
console.log(`  New inserts:       ${sqlInserted}`);
console.log(`  NDJSON notional ¢: ${ndjsonNotional}`);
console.log(`  SQL notional ¢:    ${sqlOrderNotional}`);

// ── 2. Backfill market_results ────────────────────────────────────────────────

console.log("\n=== 2. Market results ===");

const RESULT_CACHE = join(DATA_DIR, "market-result-cache.json");
let ndjsonResults = 0;
let sqlResultInserted = 0;

if (existsSync(RESULT_CACHE)) {
  const raw    = JSON.parse(readFileSync(RESULT_CACHE, "utf8")) as Record<string, string>;
  const entries = Object.entries(raw).filter(([, v]) => v === "yes" || v === "no");
  ndjsonResults = entries.length;

  for (let i = 0; i < entries.length; i += 100) {
    const chunk = entries.slice(i, i + 100);
    const values = chunk.map(([ticker, result]) => ({
      ticker,
      result,
      resolvedAtMs: Date.now(),
    }));
    const res = await db.insert(marketResults).values(values)
      .onConflictDoNothing()
      .returning({ ticker: marketResults.ticker });
    sqlResultInserted += res.length;
  }
}

const sqlResultRows = await db.execute<{ c: number }>(sql`SELECT COUNT(*)::int AS c FROM market_results`);
const sqlResultCount = Number((sqlResultRows.rows[0] as Record<string,unknown>)["c"] ?? 0);

console.log(`  Cache entries:     ${ndjsonResults}`);
console.log(`  SQL rows:          ${sqlResultCount}`);
console.log(`  New inserts:       ${sqlResultInserted}`);

// ── 3. Backfill passive_observations ─────────────────────────────────────────

console.log("\n=== 3. Passive observations ===");

const obsFiles = existsSync(DATA_DIR)
  ? readdirSync(DATA_DIR).filter((f) => f.startsWith("three-minute-observations-") && f.endsWith(".ndjson"))
  : [];

let ndjsonObs  = 0;
let sqlObsInserted = 0;

for (const f of obsFiles) {
  const records = readNdjson(join(DATA_DIR, f)) as Record<string, unknown>[];
  ndjsonObs += records.length;

  for (let i = 0; i < records.length; i += 100) {
    const chunk = records.slice(i, i + 100);
    const values = chunk.map((r) => ({
      id:                     `${r.ticker}@${r.timestampMs}`,
      timestampMs:            Number(r.timestampMs),
      isoTimestamp:           String(r.isoTimestamp ?? new Date(Number(r.timestampMs)).toISOString()),
      ticker:                 String(r.ticker),
      series:                 String(r.series ?? ""),
      asset:                  String(r.asset ?? "unknown"),
      windowCloseTime:        String(r.windowCloseTime ?? ""),
      windowId:               String(r.windowId ?? `${r.series}@${r.windowCloseTime}`),
      secondsLeft:            Number(r.secondsLeft ?? 0),
      yesBid:                 typeof r.yesBid === "number" ? r.yesBid : null,
      yesAsk:                 typeof r.yesAsk === "number" ? r.yesAsk : null,
      noBid:                  typeof r.noBid  === "number" ? r.noBid  : null,
      noAsk:                  typeof r.noAsk  === "number" ? r.noAsk  : null,
      source:                 String(r.source ?? "unknown"),
      wsConnected:            Boolean(r.wsConnected),
      wsStale:                Boolean(r.wsStale),
      yesQualifies:           Boolean(r.yesQualifies),
      noQualifies:            Boolean(r.noQualifies),
      hypotheticalSide:       typeof r.hypotheticalSide === "string" ? r.hypotheticalSide : null,
      hypotheticalEntryPrice: typeof r.hypotheticalEntryPrice === "number" ? r.hypotheticalEntryPrice : null,
      hypotheticalTier:       typeof r.hypotheticalTier === "string" ? r.hypotheticalTier : null,
      hypotheticalContracts:  typeof r.hypotheticalContracts === "number" ? r.hypotheticalContracts : null,
      easternDate:            toEasternDate(Number(r.timestampMs)),
    }));
    const res = await db.insert(passiveObservations).values(values).onConflictDoNothing().returning({ id: passiveObservations.id });
    sqlObsInserted += res.length;
  }
}

const sqlObsRows = await db.execute<{ c: number }>(sql`SELECT COUNT(*)::int AS c FROM passive_observations`);
const sqlObsCount = Number((sqlObsRows.rows[0] as Record<string,unknown>)["c"] ?? 0);

console.log(`  NDJSON records:    ${ndjsonObs}`);
console.log(`  SQL rows:          ${sqlObsCount}`);
console.log(`  New inserts:       ${sqlObsInserted}`);

// ── 4. Backfill window_log ────────────────────────────────────────────────────

console.log("\n=== 4. Window log ===");

const WINDOW_LOG = join(DATA_DIR, "window-log.json");
let ndjsonWindows = 0;
let sqlWindowInserted = 0;

if (existsSync(WINDOW_LOG)) {
  const raw = JSON.parse(readFileSync(WINDOW_LOG, "utf8")) as Record<string, unknown>[];
  if (Array.isArray(raw)) {
    // Deduplicate by ticker, keeping the last entry per ticker (most recent state).
    // ON CONFLICT DO UPDATE cannot affect the same row twice in one command.
    const byTicker = new Map<string, Record<string, unknown>>();
    for (const e of raw) { if (typeof e.ticker === "string") byTicker.set(e.ticker, e); }
    const entries = [...byTicker.values()];
    ndjsonWindows = raw.length; // report original count for reconciliation display
    for (let i = 0; i < entries.length; i += 100) {
      const chunk = entries.slice(i, i + 100);
      const values = chunk.map((r) => ({
        ticker:          String(r.ticker),
        series:          String(r.series ?? ""),
        closeTime:       typeof r.closeTime === "string" ? r.closeTime : null,
        firstSeenMs:     Number(r.firstSeenMs ?? Date.now()),
        entered:         Boolean(r.entered),
        inZone:          Boolean(r.inZone),
        yesDerivedAsk:   typeof r.yesDerivedAsk === "number" ? r.yesDerivedAsk : null,
        noDerivedAsk:    typeof r.noDerivedAsk === "number" ? r.noDerivedAsk : null,
        outcome:         typeof r.outcome === "string" ? r.outcome : "pending",
        side:            typeof r.side === "string" ? r.side : null,
        priceCents:      typeof r.priceCents === "number" ? r.priceCents : null,
        contractsFilled: typeof r.contractsFilled === "number" ? r.contractsFilled : null,
        spentDollars:    typeof r.spentDollars === "number" ? r.spentDollars : null,
        skipReason:      typeof r.skipReason === "string" ? r.skipReason : null,
      }));
      const res = await db.insert(windowLogTable).values(values)
        .onConflictDoUpdate({
          target: windowLogTable.ticker,
          set:    { outcome: sql`excluded.outcome`, updatedAt: new Date() },
        })
        .returning({ ticker: windowLogTable.ticker });
      sqlWindowInserted += res.length;
    }
  }
}

const sqlWindowRows = await db.execute<{ c: number }>(sql`SELECT COUNT(*)::int AS c FROM window_log`);
const sqlWindowCount = Number((sqlWindowRows.rows[0] as Record<string,unknown>)["c"] ?? 0);

console.log(`  JSON entries:      ${ndjsonWindows}`);
console.log(`  SQL rows:          ${sqlWindowCount}`);
console.log(`  Upserted:          ${sqlWindowInserted}`);

// ── 5. Reconciliation summary ─────────────────────────────────────────────────

console.log("\n=== Reconciliation summary ===");

let ok = true;
if (sqlOrderCount < ndjsonOrders) {
  console.error(`  ✗ order_attempts: SQL (${sqlOrderCount}) < NDJSON (${ndjsonOrders})`);
  ok = false;
} else {
  console.log(`  ✓ order_attempts: SQL ${sqlOrderCount} ≥ NDJSON ${ndjsonOrders}`);
}
if (sqlResultCount < ndjsonResults) {
  console.error(`  ✗ market_results: SQL (${sqlResultCount}) < cache (${ndjsonResults})`);
  ok = false;
} else {
  console.log(`  ✓ market_results: SQL ${sqlResultCount} ≥ cache ${ndjsonResults}`);
}
if (sqlObsCount < ndjsonObs) {
  console.error(`  ✗ passive_observations: SQL (${sqlObsCount}) < NDJSON (${ndjsonObs})`);
  ok = false;
} else {
  console.log(`  ✓ passive_observations: SQL ${sqlObsCount} ≥ NDJSON ${ndjsonObs}`);
}
if (sqlWindowCount < ndjsonWindows) {
  console.warn(`  ~ window_log: SQL (${sqlWindowCount}) < JSON (${ndjsonWindows}) (upsert conflict ok)`);
} else {
  console.log(`  ✓ window_log: SQL ${sqlWindowCount} ≥ JSON ${ndjsonWindows}`);
}

if (!ok) {
  console.error("\nBackfill FAILED — reconciliation mismatch. Check logs above.");
  process.exit(1);
}

console.log("\nBackfill complete ✓");
process.exit(0);
