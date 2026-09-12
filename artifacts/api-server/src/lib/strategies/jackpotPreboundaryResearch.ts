import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { captureOrderbook } from "../orderbookCapture.js";
import { kalshiSeriesFetch } from "../kalshi.js";
import { logger } from "../logger.js";

export const JACKPOT_PREBOUNDARY_ANCHORS = [
  ["minus_30s", -30_000],
  ["minus_10s", -10_000],
  ["minus_5s", -5_000],
  ["minus_2s", -2_000],
  ["minus_1s", -1_000],
] as const;

const armed = new Set<string>();
const POLL_MS = 10_000;

type RawMarket = Record<string, unknown>;

function timeMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function numberOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function centsFromDollars(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

function marketSnapshot(raw: RawMarket | null) {
  if (!raw) return null;
  return {
    ticker: typeof raw["ticker"] === "string" ? raw["ticker"] : null,
    status: typeof raw["status"] === "string" ? raw["status"] : null,
    openTimeMs: timeMs(raw["open_time"]),
    closeTimeMs: timeMs(raw["close_time"]),
    floorStrike: numberOrNull(raw["floor_strike"] ?? raw["cap_strike"]),
    yesBidCents: centsFromDollars(raw["yes_bid_dollars"] ?? raw["yes_bid"]),
    yesAskCents: centsFromDollars(raw["yes_ask_dollars"] ?? raw["yes_ask"]),
    noBidCents: centsFromDollars(raw["no_bid_dollars"] ?? raw["no_bid"]),
    noAskCents: centsFromDollars(raw["no_ask_dollars"] ?? raw["no_ask"]),
    liquidityDollars: numberOrNull(raw["liquidity_dollars"] ?? raw["liquidity"]),
  };
}

async function fetchFreshEthSpot(): Promise<{ eth: number; receiptMs: number } | null> {
  try {
    const response = await fetch("https://api.kraken.com/0/public/Ticker?pair=ETHUSD", { headers: { Accept: "application/json" } });
    if (!response.ok) return null;
    const data = await response.json() as { result?: { XETHZUSD?: { c?: string[] } } };
    const eth = Number(data.result?.XETHZUSD?.c?.[0]);
    if (!Number.isFinite(eth) || eth <= 0) return null;
    return { eth, receiptMs: Date.now() };
  } catch {
    return null;
  }
}

async function initTable(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS jackpot_preboundary_telemetry (
      id TEXT PRIMARY KEY,
      boundary_ms BIGINT NOT NULL,
      anchor TEXT NOT NULL,
      scheduled_at_ms BIGINT NOT NULL,
      captured_at_ms BIGINT NOT NULL,
      lateness_ms INTEGER NOT NULL,
      current_ticker TEXT,
      current_floor_strike DOUBLE PRECISION,
      next_ticker TEXT,
      next_floor_strike DOUBLE PRECISION,
      spot_eth DOUBLE PRECISION,
      spot_receipt_ms BIGINT,
      spot_to_next_strike_bps DOUBLE PRECISION,
      current_yes_bid_cents INTEGER,
      current_yes_ask_cents INTEGER,
      current_no_bid_cents INTEGER,
      current_no_ask_cents INTEGER,
      next_yes_bid_cents INTEGER,
      next_yes_ask_cents INTEGER,
      next_no_bid_cents INTEGER,
      next_no_ask_cents INTEGER,
      current_market_json JSONB,
      next_market_json JSONB,
      current_yes_book_json JSONB,
      current_no_book_json JSONB,
      next_yes_book_json JSONB,
      next_no_book_json JSONB,
      quality TEXT NOT NULL,
      UNIQUE(boundary_ms, anchor)
    )`);
  await db.execute(sql`ALTER TABLE jackpot_preboundary_telemetry ADD COLUMN IF NOT EXISTS spot_receipt_ms BIGINT`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS jackpot_preboundary_boundary_idx ON jackpot_preboundary_telemetry(boundary_ms, scheduled_at_ms)`);
}

async function capture(anchor: string, scheduledAtMs: number, boundaryMs: number): Promise<void> {
  const capturedAtMs = Date.now();
  const [currentRaw, nextRaw, spot] = await Promise.all([
    kalshiSeriesFetch("KXETH15M", { status: "open", forceFresh: true }),
    kalshiSeriesFetch("KXETH15M", { status: "unopened", forceFresh: true }),
    fetchFreshEthSpot(),
  ]);

  const current = marketSnapshot(currentRaw);
  const next = marketSnapshot(nextRaw);
  const currentTicker = current?.ticker;
  const nextTicker = next?.ticker;

  const [currentYes, currentNo, nextYes, nextNo] = await Promise.all([
    currentTicker ? captureOrderbook(currentTicker, "yes", 99).catch(() => null) : null,
    currentTicker ? captureOrderbook(currentTicker, "no", 99).catch(() => null) : null,
    nextTicker ? captureOrderbook(nextTicker, "yes", 99).catch(() => null) : null,
    nextTicker ? captureOrderbook(nextTicker, "no", 99).catch(() => null) : null,
  ]);

  const quality: string[] = [];
  if (!current || current.closeTimeMs !== boundaryMs) quality.push("current_market_mismatch_or_missing");
  if (!next || next.openTimeMs !== boundaryMs) quality.push("next_market_unavailable_preopen");
  if (next?.floorStrike == null) quality.push("next_strike_missing");
  if (!spot) quality.push("spot_missing");
  if (capturedAtMs - scheduledAtMs > 1_500) quality.push("anchor_late");

  const spotEth = spot?.eth ?? null;
  const spotToNextStrikeBps = spotEth != null && next?.floorStrike != null && next.floorStrike > 0
    ? ((spotEth - next.floorStrike) / next.floorStrike) * 10_000
    : null;

  await db.execute(sql`
    INSERT INTO jackpot_preboundary_telemetry (
      id, boundary_ms, anchor, scheduled_at_ms, captured_at_ms, lateness_ms,
      current_ticker, current_floor_strike, next_ticker, next_floor_strike,
      spot_eth, spot_receipt_ms, spot_to_next_strike_bps,
      current_yes_bid_cents, current_yes_ask_cents, current_no_bid_cents, current_no_ask_cents,
      next_yes_bid_cents, next_yes_ask_cents, next_no_bid_cents, next_no_ask_cents,
      current_market_json, next_market_json,
      current_yes_book_json, current_no_book_json, next_yes_book_json, next_no_book_json,
      quality
    ) VALUES (
      ${`${boundaryMs}:${anchor}`}, ${boundaryMs}, ${anchor}, ${scheduledAtMs}, ${capturedAtMs}, ${capturedAtMs - scheduledAtMs},
      ${current?.ticker ?? null}, ${current?.floorStrike ?? null}, ${next?.ticker ?? null}, ${next?.floorStrike ?? null},
      ${spotEth}, ${spot?.receiptMs ?? null}, ${spotToNextStrikeBps},
      ${current?.yesBidCents ?? null}, ${current?.yesAskCents ?? null}, ${current?.noBidCents ?? null}, ${current?.noAskCents ?? null},
      ${next?.yesBidCents ?? null}, ${next?.yesAskCents ?? null}, ${next?.noBidCents ?? null}, ${next?.noAskCents ?? null},
      ${currentRaw ? JSON.stringify(currentRaw) : null}::jsonb, ${nextRaw ? JSON.stringify(nextRaw) : null}::jsonb,
      ${currentYes ? JSON.stringify(currentYes) : null}::jsonb, ${currentNo ? JSON.stringify(currentNo) : null}::jsonb,
      ${nextYes ? JSON.stringify(nextYes) : null}::jsonb, ${nextNo ? JSON.stringify(nextNo) : null}::jsonb,
      ${quality.join(",") || "complete"}
    ) ON CONFLICT (boundary_ms, anchor) DO NOTHING`);

  logger.info({
    service: "J", research: "preboundary", anchor, boundaryMs,
    currentTicker: current?.ticker ?? null, nextTicker: next?.ticker ?? null,
    nextStrike: next?.floorStrike ?? null, spotEth, spotReceiptMs: spot?.receiptMs ?? null,
    spotToNextStrikeBps, quality: quality.join(",") || "complete",
  }, "Jackpot pre-boundary telemetry captured");
}

function armBoundary(current: RawMarket): void {
  const ticker = typeof current["ticker"] === "string" ? current["ticker"] : null;
  const boundaryMs = timeMs(current["close_time"]);
  if (!ticker || !ticker.startsWith("KXETH15M-") || boundaryMs == null) return;
  const now = Date.now();
  for (const [anchor, offset] of JACKPOT_PREBOUNDARY_ANCHORS) {
    const scheduledAtMs = boundaryMs + offset;
    const key = `${boundaryMs}:${anchor}`;
    if (armed.has(key) || scheduledAtMs <= now) continue;
    armed.add(key);
    const timer = setTimeout(() => { void capture(anchor, scheduledAtMs, boundaryMs); }, scheduledAtMs - now);
    timer.unref();
  }
}

export async function startJackpotPreboundaryResearch(): Promise<void> {
  await initTable();
  const poll = async () => {
    try {
      const current = await kalshiSeriesFetch("KXETH15M", { status: "open", forceFresh: true });
      if (current) armBoundary(current);
    } catch (err) {
      logger.warn({ err, service: "J", research: "preboundary" }, "Jackpot pre-boundary arm poll failed");
    }
  };
  await poll();
  const timer = setInterval(() => { void poll(); }, POLL_MS);
  timer.unref();
  logger.info({ service: "J", research: "preboundary", anchors: JACKPOT_PREBOUNDARY_ANCHORS.map(([a]) => a), freshSpot: true }, "Jackpot pre-boundary research collector started");
}
