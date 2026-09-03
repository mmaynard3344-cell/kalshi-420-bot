/**
 * Append-only evidence for scheduled KXETH15M boundary discovery. This is
 * intentionally separate from final-window coverage: it records market
 * availability and runner timing, never quote-health classification.
 */
import { appendFileSync, createReadStream, mkdirSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { easternDay } from "./dailyBudget.js";

export type BoundaryDiscoveryStage =
  | "upcoming_seen" | "probe_started" | "active_response" | "usable_metadata"
  | "rollover" | "evaluation_started" | "reservation" | "exchange_submission"
  | "executor_blocked" | "probe_deferred" | "probe_exhausted";

export interface BoundaryDiscoveryAuditEvent {
  ticker: string;
  openTimeMs: number;
  atMs: number;
  stage: BoundaryDiscoveryStage;
  reason: string | null;
}

function dataDir(): string {
  return process.env["BOUNDARY_DISCOVERY_DATA_DIR"] ?? join(process.cwd(), "data", "analytics");
}

function writableDataDir(): string {
  const dir = dataDir();
  try { mkdirSync(dir, { recursive: true }); } catch { /* best effort only */ }
  return dir;
}

/** Best-effort durable evidence; discovery and trading never wait for it. */
export function recordBoundaryDiscoveryAudit(event: BoundaryDiscoveryAuditEvent): void {
  try {
    appendFileSync(
      join(writableDataDir(), `boundary-discovery-${easternDay(new Date(event.atMs))}.ndjson`),
      `${JSON.stringify(event)}\n`,
      "utf8",
    );
  } catch { /* observability must not affect the order path */ }
}

export interface BoundaryDiscoveryTimeline {
  ticker: string;
  /** The exchange-provided opening time for this 15-minute ETH market. */
  openTimeMs: number;
  events: BoundaryDiscoveryAuditEvent[];
  /**
   * Distinguishes a fresh exchange response whose metadata could not yet be
   * used from a timeline where no fresh response was recorded at all.
   */
  metadataState: "not_applicable" | "unavailable" | "usable";
}

export interface BoundaryDiscoveryTimelineReport {
  /** False means the audit ledger could not be read; an empty timeline list is not inferred. */
  available: boolean;
  timelines: BoundaryDiscoveryTimeline[];
}

type BoundaryDiscoveryTimelineEvidence = Omit<BoundaryDiscoveryTimeline, "metadataState">;

function isAuditEvent(value: unknown): value is BoundaryDiscoveryAuditEvent {
  if (value == null || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  return typeof event["ticker"] === "string"
    && event["ticker"].startsWith("KXETH15M-")
    && Number.isFinite(event["openTimeMs"])
    && Number.isFinite(event["atMs"])
    && typeof event["stage"] === "string"
    && (event["reason"] === null || typeof event["reason"] === "string");
}

/**
 * Reads a small, bounded recent slice of the append-only audit ledger for the
 * dashboard. It never creates files or changes execution state. Individual
 * lines are tolerated independently so a malformed record cannot hide the
 * remaining boundary evidence.
 */
export async function loadRecentBoundaryDiscoveryTimelines(limit = 24): Promise<BoundaryDiscoveryTimelineReport> {
  let names: string[];
  try {
    names = await readdir(dataDir());
  } catch {
    return { available: false, timelines: [] };
  }

  // A 15-minute market has at most 96 windows/day. Three date partitions
  // comfortably cover the requested recent windows without repeatedly scanning
  // an unbounded audit history on dashboard polling.
  const files = names
    .filter((name) => /^boundary-discovery-\d{4}-\d{2}-\d{2}\.ndjson$/.test(name))
    .sort()
    .reverse()
    .slice(0, 3);
  const grouped = new Map<string, BoundaryDiscoveryTimelineEvidence>();

  try {
    for (const filename of files) {
      const lines = createInterface({
        input: createReadStream(join(dataDir(), filename), { encoding: "utf8" }),
        crlfDelay: Infinity,
      });
      for await (const line of lines) {
        if (!line.trim()) continue;
        let parsed: unknown;
        try { parsed = JSON.parse(line); } catch { continue; }
        if (!isAuditEvent(parsed)) continue;
        const key = `${parsed.ticker}::${parsed.openTimeMs}`;
        const timeline = grouped.get(key) ?? {
          ticker: parsed.ticker,
          openTimeMs: parsed.openTimeMs,
          events: [],
        };
        timeline.events.push(parsed);
        grouped.set(key, timeline);
      }
    }
  } catch {
    return { available: false, timelines: [] };
  }

  const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), 100) : 24;
  return {
    available: true,
    timelines: [...grouped.values()]
      .map((timeline) => {
        const events = timeline.events.sort((a, b) => a.atMs - b.atMs);
        const hasActiveResponse = events.some((event) => event.stage === "active_response");
        const hasUsableMetadata = events.some((event) => event.stage === "usable_metadata");
        const metadataState: BoundaryDiscoveryTimeline["metadataState"] = hasUsableMetadata
          ? "usable"
          : hasActiveResponse
            ? "unavailable"
            : "not_applicable";
        return {
          ...timeline,
          events,
          metadataState,
        };
      })
      .sort((a, b) => b.openTimeMs - a.openTimeMs)
      .slice(0, safeLimit),
  };
}