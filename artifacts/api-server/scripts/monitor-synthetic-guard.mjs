#!/usr/bin/env node
/**
 * monitor-synthetic-guard.mjs
 *
 * Polls the local API server every POLL_INTERVAL_MS until it captures the
 * first live in-zone tick where isExecutableLiquidity() was evaluated.
 *
 * Writes structured results to /tmp/synthetic-guard-capture.json
 * and a human-readable summary to /tmp/synthetic-guard-capture.log
 *
 * Exit codes:
 *   0 — captured a live event (executable or not)
 *   1 — timed out (MAX_RUNTIME_MS elapsed without a qualifying event)
 */

import { readFileSync, writeFileSync, appendFileSync } from "fs";

const BASE_URL          = "http://localhost:80";
const POLL_INTERVAL_MS  = 8_000;        // 8 s — fast enough to catch a tick
const MAX_RUNTIME_MS    = 7_200_000;    // 2 hours
const CAPTURE_FILE      = "/tmp/synthetic-guard-capture.json";
const LOG_FILE          = "/tmp/synthetic-guard-capture.log";

// ─── helpers ────────────────────────────────────────────────────────────────

function ts() {
  return new Date().toISOString();
}

function log(msg) {
  const line = `[${ts()}] ${msg}`;
  console.log(line);
  appendFileSync(LOG_FILE, line + "\n");
}

async function get(path) {
  try {
    const r = await fetch(`${BASE_URL}${path}`, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

// ─── state ─────────────────────────────────────────────────────────────────

let lastGuardSnapshot   = null;   // last /reports/guards response
let lastDailySnapshot   = null;   // last /analytics/daily  response
let lastOrderCount      = null;   // SQL order_attempt count from storage/status
let capturedEvent       = null;

// ─── capture helpers ───────────────────────────────────────────────────────

async function captureFullState(reason, guardData, dailyData, storageData) {
  const windowLog = await get("/api/trade/analytics/windows");
  const orders    = await get("/api/trade/analytics/orders?limit=5");

  const event = {
    captured_at:    ts(),
    capture_reason: reason,
    guard_counts:   guardData,
    daily_summary:  dailyData,
    storage_status: storageData,
    recent_windows: windowLog?.windows?.slice(0, 4) ?? null,
    recent_orders:  orders,
  };

  writeFileSync(CAPTURE_FILE, JSON.stringify(event, null, 2));
  log(`CAPTURED: ${reason}`);
  log(`  guard counts: ${JSON.stringify(guardData?.combined?.map(g => `${g.guard}=${g.count}`))}`);
  log(`  daily eth: ${JSON.stringify(dailyData?.eth ?? dailyData?.ETH)}`);
  log(`  order count: ${storageData?.orderAttemptCount}`);

  // Pretty-print the most recent window entries for ETH and BTC
  if (windowLog?.windows) {
    for (const w of windowLog.windows.slice(0, 4)) {
      if (w.outcome !== "pending" && w.outcome !== "out_of_zone") continue;
      log(`  window ${w.ticker}: outcome=${w.outcome} inZone=${w.inZone} entered=${w.entered} yesDerivedAsk=${w.yesDerivedAsk} noDerivedAsk=${w.noDerivedAsk}`);
    }
  }

  return event;
}

// ─── main loop ─────────────────────────────────────────────────────────────

const startMs = Date.now();
log("=== synthetic-guard monitor started ===");
log(`  polling every ${POLL_INTERVAL_MS / 1000}s, timeout in ${MAX_RUNTIME_MS / 60000}m`);
log(`  capture file: ${CAPTURE_FILE}`);
log(`  looking for: synthetic_quote_not_executable > 0  OR  in-zone executable order`);

while (Date.now() - startMs < MAX_RUNTIME_MS) {
  await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

  const [guards, daily, storage] = await Promise.all([
    get("/api/trade/analytics/reports/guards"),
    get("/api/trade/analytics/daily"),
    get("/api/trade/storage/status"),
  ]);

  if (!guards || !storage) {
    log("WARN: could not reach API (server restarting?)");
    continue;
  }

  const syntheticCount =
    guards?.combined?.find(g => g.guard === "synthetic_quote_not_executable")?.count ?? 0;

  const currentOrderCount = storage?.orderAttemptCount ?? 0;

  // ── 1. synthetic_quote_not_executable fired ──────────────────────────────
  if (syntheticCount > 0) {
    const prev = lastGuardSnapshot?.combined?.find(g => g.guard === "synthetic_quote_not_executable")?.count ?? 0;
    if (syntheticCount > prev) {
      log(`*** synthetic_quote_not_executable: count now ${syntheticCount} (was ${prev})`);
      capturedEvent = await captureFullState(
        `synthetic_quote_not_executable (count=${syntheticCount})`,
        guards, daily, storage
      );
      break;
    }
  }

  // ── 2. A new order_attempt was written (executable + zone hit) ───────────
  if (lastOrderCount !== null && currentOrderCount > lastOrderCount) {
    log(`*** new order_attempt row: total now ${currentOrderCount} (was ${lastOrderCount})`);
    capturedEvent = await captureFullState(
      `new_order_attempt (total=${currentOrderCount})`,
      guards, daily, storage
    );
    break;
  }

  // ── 3. Periodic heartbeat every ~5 min so progress is visible ────────────
  const elapsed = Math.round((Date.now() - startMs) / 1000);
  if (elapsed % 300 < POLL_INTERVAL_MS / 1000) {
    const inZoneEth = daily?.eth?.inZoneWindows ?? "?";
    log(`heartbeat t+${elapsed}s | orders=${currentOrderCount} | synthetic=${syntheticCount} | ethInZoneWindows=${inZoneEth}`);
  }

  lastGuardSnapshot = guards;
  lastDailySnapshot = daily;
  lastOrderCount    = currentOrderCount;
}

if (capturedEvent) {
  log("=== monitor complete — event captured ===");
  process.exit(0);
} else {
  log("=== monitor timed out without capturing a qualifying event ===");
  process.exit(1);
}
