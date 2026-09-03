/**
 * Restart-proof persistence for the Phase 4B reference-price proxy history.
 * Passive research only: this module never touches orders, routes, or strategy.
 * Points are retained for a bounded window, persisted atomically to a small
 * JSON file, and reloaded lazily after a restart so a qualifying quote captured
 * shortly after startup can still be paired with a causal (at-or-before)
 * reference observation.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { RawReferencePoint } from "./referenceFeatures.js";

export const PHASE4B_REFERENCE_RETENTION_MS = 15 * 60_000;

let historyPath = process.env["PHASE4B_REFERENCE_HISTORY_PATH"]
  ?? join(process.cwd(), "data", "phase4b", "reference-history.json");
let loaded = false;
let testResetDirectory: string | null = null;
const history = new Map<string, RawReferencePoint[]>();
let corruptReloadCount = 0;

function isValidPoint(point: unknown): point is RawReferencePoint {
  return typeof point === "object" && point !== null
    && Number.isFinite((point as RawReferencePoint).timestampMs)
    && Number.isFinite((point as RawReferencePoint).price)
    && (point as RawReferencePoint).price > 0;
}

function loadIfNeeded(nowMs: number): void {
  if (loaded) return;
  loaded = true;
  const markCorrupt = (reason: string, error?: unknown): void => {
    corruptReloadCount++;
    const corruptPath = `${historyPath}.corrupt`;
    try { renameSync(historyPath, corruptPath); } catch { /* best-effort */ }
    console.warn("phase4b: reference history load failed; starting empty", {
      historyPath, corruptPath, corruptReloadCount, reason,
      error: error instanceof Error ? error.message : error != null ? String(error) : undefined,
    });
  };

  try {
    if (!existsSync(historyPath)) return;
    const raw: unknown = JSON.parse(readFileSync(historyPath, "utf8"));
    // A valid history file must be a plain object map, not an array or primitive.
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      markCorrupt("invalid_top_level_shape");
      return;
    }
    const parsed = raw as Record<string, unknown>;
    // Schema validation pass: every asset value must be an array of structurally
    // valid points. Expired or future-timestamped points are a clock-safety concern
    // handled below, not a schema violation.
    for (const [asset, points] of Object.entries(parsed)) {
      if (!Array.isArray(points)) {
        markCorrupt("invalid_asset_value");
        return;
      }
      for (const point of points) {
        if (!isValidPoint(point)) {
          markCorrupt("invalid_point_schema");
          return;
        }
      }
    }
    // Schema is valid; apply clock/retention filters.
    for (const [asset, points] of Object.entries(parsed)) {
      // Clock safety: never resurrect points claiming to be from the future,
      // and drop anything past the retention window.
      const valid = (points as RawReferencePoint[])
        .filter((point) => point.timestampMs <= nowMs && point.timestampMs >= nowMs - PHASE4B_REFERENCE_RETENTION_MS)
        .sort((a, b) => a.timestampMs - b.timestampMs);
      if (valid.length) history.set(asset, valid);
    }
  } catch (error) {
    markCorrupt("json_parse_error", error);
  }
}

function persist(): void {
  try {
    mkdirSync(dirname(historyPath), { recursive: true });
    const temporary = `${historyPath}.tmp`;
    writeFileSync(temporary, JSON.stringify(Object.fromEntries(history)), "utf8");
    renameSync(temporary, historyPath);
  } catch (error) {
    console.warn("phase4b: reference history persist failed", {
      historyPath, error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function getReferenceHistory(asset: string, nowMs: number): RawReferencePoint[] {
  loadIfNeeded(nowMs);
  return [...(history.get(asset) ?? [])];
}

export function appendReferencePoint(asset: string, point: RawReferencePoint, nowMs: number): RawReferencePoint[] {
  loadIfNeeded(nowMs);
  if (!isValidPoint(point)) return getReferenceHistory(asset, nowMs);
  const floor = nowMs - PHASE4B_REFERENCE_RETENTION_MS;
  const next = (history.get(asset) ?? [])
    .filter((existing) => existing.timestampMs !== point.timestampMs)
    .concat({ timestampMs: point.timestampMs, price: point.price })
    .filter((candidate) => candidate.timestampMs >= floor)
    .sort((a, b) => a.timestampMs - b.timestampMs);
  history.set(asset, next);
  persist();
  return [...next];
}

/** Returns the number of times a corrupt history file has been detected since process start. */
export function getPhase4BReferenceHistoryCorruptReloadCount(): number {
  return corruptReloadCount;
}

/** Test seam: point at an explicit file and force a reload (simulates restart). */
export function _setPhase4BReferenceHistoryPathForTesting(path: string): void {
  historyPath = path;
  loaded = false;
  history.clear();
}

export function _resetPhase4BReferenceHistoryForTesting(): void {
  if (testResetDirectory) rmSync(testResetDirectory, { recursive: true, force: true });
  testResetDirectory = mkdtempSync(join(tmpdir(), "phase4b-reference-history-"));
  historyPath = join(testResetDirectory, "reference-history.json");
  loaded = false;
  history.clear();
  corruptReloadCount = 0;
}
