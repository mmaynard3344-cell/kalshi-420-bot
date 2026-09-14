import { sql } from "drizzle-orm";
import { logger } from "../logger.js";
import { kalshiFetch } from "../kalshi.js";

const ETH_15M_MS = 15 * 60_000;
const WRITE_REFRESH_MS = 60_000;
const SCHEMA_LOCK = 42015001;

export interface EthSignalEvidenceInput {
  serviceRole: string;
  ticker: string;
  marketOpenTimeMs: number | null;
  observedAtMs: number;
  currentFloorStrike?: number | null;
  priorFloorStrike?: number | null;
  currentMove?: number | null;
  direction?: string | null;
  p80?: number | null;
  p90?: number | null;
  p95?: number | null;
  p99?: number | null;
  sampleCount?: number | null;
  rejectionReason?: string | null;
  outcome?: string | null;
  evidence?: Record<string, unknown>;
}

let initPromise: Promise<void> | null = null;
const lastFingerprint = new Map<string, string>();
const lastWriteAt = new Map<string, number>();

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function positiveStrike(raw: Record<string, unknown> | null | undefined): number | null {
  if (!raw) return null;
  const value = raw["floor_strike"] ?? raw["cap_strike"];
  const parsed = typeof value === "number" ? value
    : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

async function getDb() {
  const mod = await import("@workspace/db");
  return mod.db;
}

async function ensureTable(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      const db = await getDb();
      await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${SCHEMA_LOCK})`);
        await tx.execute(sql`
          CREATE TABLE IF NOT EXISTS eth_signal_evidence_ledger (
            service_role text NOT NULL,
            ticker text NOT NULL,
            market_open_time_ms bigint NOT NULL,
            observed_at_ms bigint NOT NULL,
            current_floor_strike double precision,
            prior_floor_strike double precision,
            current_move double precision,
            direction text,
            p80 double precision,
            p90 double precision,
            p95 double precision,
            p99 double precision,
            sample_count integer,
            rejection_reason text,
            outcome text,
            evidence_json text NOT NULL DEFAULT '{}',
            updated_at_ms bigint NOT NULL,
            PRIMARY KEY (service_role, ticker)
          )
        `);
        await tx.execute(sql`
          CREATE INDEX IF NOT EXISTS eth_signal_evidence_ledger_updated_idx
          ON eth_signal_evidence_ledger (updated_at_ms DESC)
        `);
      });
    })().catch((err) => {
      initPromise = null;
      throw err;
    });
  }
  return initPromise;
}

async function enrichStrikes(input: EthSignalEvidenceInput): Promise<{ current: number | null; prior: number | null }> {
  let current = finiteOrNull(input.currentFloorStrike);
  let prior = finiteOrNull(input.priorFloorStrike);
  const openMs = input.marketOpenTimeMs;
  if (!Number.isInteger(openMs) || openMs! <= 0 || !/^KXETH15M-/.test(input.ticker)) return { current, prior };
  try {
    if (current == null) {
      const response = await kalshiFetch<{ market?: Record<string, unknown> }>(`/markets/${input.ticker}`);
      const raw = response.market;
      const rawOpen = typeof raw?.["open_time"] === "string" ? Date.parse(raw["open_time"] as string) : NaN;
      if (rawOpen === openMs) current = positiveStrike(raw);
    }
    if (prior == null) {
      const target = openMs! - ETH_15M_MS;
      const response = await kalshiFetch<{ markets?: Array<Record<string, unknown>> }>(
        "/markets", { series_ticker: "KXETH15M", status: "settled", limit: 100 },
      );
      const matches = (response.markets ?? []).filter((row) => {
        const rowOpen = typeof row["open_time"] === "string" ? Date.parse(row["open_time"] as string) : NaN;
        return rowOpen === target && typeof row["ticker"] === "string" && /^KXETH15M-/.test(row["ticker"] as string);
      });
      const strikes = new Set(matches.map(positiveStrike).filter((v): v is number => v != null));
      if (strikes.size === 1) prior = [...strikes][0]!;
    }
  } catch {
    // Audit enrichment is deliberately non-authoritative and never gates trading.
  }
  return { current, prior };
}

async function persist(input: EthSignalEvidenceInput): Promise<void> {
  if (!input.serviceRole || !/^KXETH15M-/.test(input.ticker)) return;
  const openMs = input.marketOpenTimeMs;
  if (!Number.isInteger(openMs) || openMs! <= 0) return;
  const key = `${input.serviceRole}:${input.ticker}`;
  const fingerprint = JSON.stringify({
    currentMove: finiteOrNull(input.currentMove), direction: input.direction ?? null,
    p80: finiteOrNull(input.p80), p90: finiteOrNull(input.p90), p95: finiteOrNull(input.p95), p99: finiteOrNull(input.p99),
    sampleCount: Number.isInteger(input.sampleCount) ? input.sampleCount : null,
    rejectionReason: input.rejectionReason ?? null, outcome: input.outcome ?? null,
    evidence: input.evidence ?? {},
  });
  const now = Date.now();
  if (lastFingerprint.get(key) === fingerprint && now - (lastWriteAt.get(key) ?? 0) < WRITE_REFRESH_MS) return;

  const strikes = await enrichStrikes(input);
  await ensureTable();
  const db = await getDb();
  const currentMove = finiteOrNull(input.currentMove);
  const p80 = finiteOrNull(input.p80), p90 = finiteOrNull(input.p90), p95 = finiteOrNull(input.p95), p99 = finiteOrNull(input.p99);
  const sampleCount = Number.isInteger(input.sampleCount) ? input.sampleCount! : null;
  const direction = input.direction ?? null;
  const rejectionReason = input.rejectionReason ?? null;
  const outcome = input.outcome ?? null;
  const evidenceJson = JSON.stringify(input.evidence ?? {});
  await db.execute(sql`
    INSERT INTO eth_signal_evidence_ledger
      (service_role, ticker, market_open_time_ms, observed_at_ms,
       current_floor_strike, prior_floor_strike, current_move, direction,
       p80, p90, p95, p99, sample_count, rejection_reason, outcome,
       evidence_json, updated_at_ms)
    VALUES
      (${input.serviceRole}, ${input.ticker}, ${openMs!}, ${input.observedAtMs},
       ${strikes.current}, ${strikes.prior}, ${currentMove}, ${direction},
       ${p80}, ${p90}, ${p95}, ${p99}, ${sampleCount}, ${rejectionReason}, ${outcome},
       ${evidenceJson}, ${now})
    ON CONFLICT (service_role, ticker) DO UPDATE SET
      market_open_time_ms=EXCLUDED.market_open_time_ms,
      observed_at_ms=EXCLUDED.observed_at_ms,
      current_floor_strike=COALESCE(EXCLUDED.current_floor_strike, eth_signal_evidence_ledger.current_floor_strike),
      prior_floor_strike=COALESCE(EXCLUDED.prior_floor_strike, eth_signal_evidence_ledger.prior_floor_strike),
      current_move=EXCLUDED.current_move,
      direction=EXCLUDED.direction,
      p80=EXCLUDED.p80, p90=EXCLUDED.p90, p95=EXCLUDED.p95, p99=EXCLUDED.p99,
      sample_count=EXCLUDED.sample_count,
      rejection_reason=EXCLUDED.rejection_reason,
      outcome=EXCLUDED.outcome,
      evidence_json=EXCLUDED.evidence_json,
      updated_at_ms=EXCLUDED.updated_at_ms
  `);
  lastFingerprint.set(key, fingerprint);
  lastWriteAt.set(key, now);
  logger.info({ serviceRole: input.serviceRole, ticker: input.ticker }, "ETH_SIGNAL_EVIDENCE_LEDGER_UPSERTED");
}

export function scheduleEthSignalEvidence(input: EthSignalEvidenceInput): void {
  void persist(input).catch((err) => {
    logger.warn({ err, serviceRole: input.serviceRole, ticker: input.ticker }, "ETH_SIGNAL_EVIDENCE_LEDGER_WRITE_FAILED");
  });
}
