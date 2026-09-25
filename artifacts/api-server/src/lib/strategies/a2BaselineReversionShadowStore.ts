import { sql } from "drizzle-orm";

export const A2_SHADOW_ADVISORY_LOCK = 42017002;

export async function ensureA2BaselineReversionShadowSchema(db: DbLike): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS a2_baseline_reversion_evidence (
      id text PRIMARY KEY,
      observed_at_ms bigint NOT NULL,
      source_open_time_ms bigint NOT NULL,
      source_close_time_ms bigint NOT NULL,
      source_open double precision NOT NULL,
      source_high double precision NOT NULL,
      source_low double precision NOT NULL,
      source_close double precision NOT NULL,
      source_drop_fraction double precision,
      destination_ticker text NOT NULL,
      destination_open_time_ms bigint NOT NULL,
      destination_close_time_ms bigint NOT NULL,
      yes_semantics_verified boolean NOT NULL,
      observed_yes_ask_cents integer,
      signal boolean NOT NULL,
      reason text,
      stake_cents integer NOT NULL,
      max_entry_price_cents integer NOT NULL,
      active_exposure_count_observed integer NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS a2_baseline_reversion_evidence_observed_idx
      ON a2_baseline_reversion_evidence (observed_at_ms DESC);
    CREATE INDEX IF NOT EXISTS a2_baseline_reversion_evidence_ticker_idx
      ON a2_baseline_reversion_evidence (destination_ticker);

    CREATE TABLE IF NOT EXISTS a2_baseline_reversion_shadow_claims (
      id text PRIMARY KEY,
      strategy_id text NOT NULL,
      source_open_time_ms bigint NOT NULL,
      source_close_time_ms bigint NOT NULL,
      destination_ticker text NOT NULL,
      destination_open_time_ms bigint NOT NULL,
      side text NOT NULL,
      stake_cents integer NOT NULL,
      max_entry_price_cents integer NOT NULL,
      observed_yes_ask_cents integer NOT NULL,
      source_drop_fraction double precision NOT NULL,
      state text NOT NULL,
      claimed_at_ms bigint NOT NULL,
      settlement_result text,
      settled_at_ms bigint,
      updated_at_ms bigint NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (source_open_time_ms, destination_ticker)
    );
    CREATE INDEX IF NOT EXISTS a2_baseline_reversion_shadow_claims_state_idx
      ON a2_baseline_reversion_shadow_claims (state, claimed_at_ms);
    CREATE INDEX IF NOT EXISTS a2_baseline_reversion_shadow_claims_ticker_idx
      ON a2_baseline_reversion_shadow_claims (destination_ticker);
  `);
}

export type A2ShadowClaimState = "shadow_open" | "shadow_settled";
export type A2ShadowClaimOutcome =
  | "opened"
  | "duplicate"
  | "active_exposure_limit"
  | "store_unavailable";

export interface A2ShadowEvidenceRecord {
  id: string;
  observedAtMs: number;
  sourceOpenTimeMs: number;
  sourceCloseTimeMs: number;
  sourceOpen: number;
  sourceHigh: number;
  sourceLow: number;
  sourceClose: number;
  sourceDropFraction: number | null;
  destinationTicker: string;
  destinationOpenTimeMs: number;
  destinationCloseTimeMs: number;
  yesSemanticsVerified: boolean;
  observedYesAskCents: number | null;
  signal: boolean;
  reason: string | null;
  stakeCents: number;
  maxEntryPriceCents: number;
  activeExposureCountObserved: number;
}

export interface A2ShadowClaimInput {
  id: string;
  strategyId: "a2_baseline_reversion";
  sourceOpenTimeMs: number;
  sourceCloseTimeMs: number;
  destinationTicker: string;
  destinationOpenTimeMs: number;
  side: "yes";
  stakeCents: 500;
  maxEntryPriceCents: 45;
  observedYesAskCents: number;
  sourceDropFraction: number;
  claimedAtMs: number;
}

export interface A2ShadowStore {
  recordEvidence(input: A2ShadowEvidenceRecord): Promise<boolean>;
  countOpen(): Promise<number | null>;
  listOpen(): Promise<Array<{ id: string; destinationTicker: string }>>;
  claimOpen(input: A2ShadowClaimInput): Promise<A2ShadowClaimOutcome>;
  settle(input: {
    id: string;
    settlementResult: "yes" | "no";
    settledAtMs: number;
  }): Promise<boolean>;
}

type DbLike = {
  execute(query: unknown): Promise<unknown>;
  transaction<T>(fn: (tx: DbLike) => Promise<T>): Promise<T>;
};

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  return (result as { rows?: Array<Record<string, unknown>> })?.rows ?? [];
}

function nonnegativeSafe(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validClaim(input: A2ShadowClaimInput): boolean {
  return Boolean(input.id)
    && input.strategyId === "a2_baseline_reversion"
    && nonnegativeSafe(input.sourceOpenTimeMs)
    && nonnegativeSafe(input.sourceCloseTimeMs)
    && input.sourceCloseTimeMs > input.sourceOpenTimeMs
    && /^KXBTC15M-/.test(input.destinationTicker)
    && nonnegativeSafe(input.destinationOpenTimeMs)
    && input.destinationOpenTimeMs === input.sourceCloseTimeMs
    && input.side === "yes"
    && input.stakeCents === 500
    && input.maxEntryPriceCents === 45
    && Number.isInteger(input.observedYesAskCents)
    && input.observedYesAskCents >= 1
    && input.observedYesAskCents <= 45
    && Number.isFinite(input.sourceDropFraction)
    && input.sourceDropFraction >= 0
    && nonnegativeSafe(input.claimedAtMs);
}

export class PostgresA2ShadowStore implements A2ShadowStore {
  constructor(private readonly db: DbLike) {}

  async recordEvidence(input: A2ShadowEvidenceRecord): Promise<boolean> {
    try {
      const result = await this.db.execute(sql`
        INSERT INTO a2_baseline_reversion_evidence
          (id, observed_at_ms, source_open_time_ms, source_close_time_ms,
           source_open, source_high, source_low, source_close, source_drop_fraction,
           destination_ticker, destination_open_time_ms, destination_close_time_ms,
           yes_semantics_verified, observed_yes_ask_cents, signal, reason,
           stake_cents, max_entry_price_cents, active_exposure_count_observed)
        VALUES
          (${input.id}, ${input.observedAtMs}, ${input.sourceOpenTimeMs}, ${input.sourceCloseTimeMs},
           ${input.sourceOpen}, ${input.sourceHigh}, ${input.sourceLow}, ${input.sourceClose}, ${input.sourceDropFraction},
           ${input.destinationTicker}, ${input.destinationOpenTimeMs}, ${input.destinationCloseTimeMs},
           ${input.yesSemanticsVerified}, ${input.observedYesAskCents}, ${input.signal}, ${input.reason},
           ${input.stakeCents}, ${input.maxEntryPriceCents}, ${input.activeExposureCountObserved})
        ON CONFLICT (id) DO NOTHING
        RETURNING id
      `);
      return rowsOf(result).length === 1;
    } catch {
      return false;
    }
  }

  async countOpen(): Promise<number | null> {
    try {
      const result = await this.db.execute(sql`
        SELECT COUNT(*)::int AS open_count
        FROM a2_baseline_reversion_shadow_claims
        WHERE state='shadow_open'
      `);
      const count = Number(rowsOf(result)[0]?.["open_count"]);
      return nonnegativeSafe(count) ? count : null;
    } catch {
      return null;
    }
  }

  async listOpen(): Promise<Array<{ id: string; destinationTicker: string }>> {
    try {
      const result = await this.db.execute(sql`
        SELECT id, destination_ticker
        FROM a2_baseline_reversion_shadow_claims
        WHERE state='shadow_open'
        ORDER BY claimed_at_ms ASC
      `);
      return rowsOf(result)
        .filter((row) => typeof row["id"] === "string" && typeof row["destination_ticker"] === "string")
        .map((row) => ({
          id: row["id"] as string,
          destinationTicker: row["destination_ticker"] as string,
        }));
    } catch {
      return [];
    }
  }

  async claimOpen(input: A2ShadowClaimInput): Promise<A2ShadowClaimOutcome> {
    if (!validClaim(input)) return "store_unavailable";
    try {
      return await this.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${A2_SHADOW_ADVISORY_LOCK})`);

        const duplicate = await tx.execute(sql`
          SELECT id
          FROM a2_baseline_reversion_shadow_claims
          WHERE id=${input.id}
             OR (source_open_time_ms=${input.sourceOpenTimeMs}
                 AND destination_ticker=${input.destinationTicker})
          LIMIT 1
        `);
        if (rowsOf(duplicate).length > 0) return "duplicate";

        const active = await tx.execute(sql`
          SELECT COUNT(*)::int AS open_count
          FROM a2_baseline_reversion_shadow_claims
          WHERE state='shadow_open'
        `);
        const openCount = Number(rowsOf(active)[0]?.["open_count"]);
        if (!nonnegativeSafe(openCount)) return "store_unavailable";
        if (openCount >= 1) return "active_exposure_limit";

        const inserted = await tx.execute(sql`
          INSERT INTO a2_baseline_reversion_shadow_claims
            (id, strategy_id, source_open_time_ms, source_close_time_ms,
             destination_ticker, destination_open_time_ms, side, stake_cents,
             max_entry_price_cents, observed_yes_ask_cents, source_drop_fraction,
             state, claimed_at_ms, updated_at_ms)
          VALUES
            (${input.id}, ${input.strategyId}, ${input.sourceOpenTimeMs}, ${input.sourceCloseTimeMs},
             ${input.destinationTicker}, ${input.destinationOpenTimeMs}, ${input.side}, ${input.stakeCents},
             ${input.maxEntryPriceCents}, ${input.observedYesAskCents}, ${input.sourceDropFraction},
             'shadow_open', ${input.claimedAtMs}, ${input.claimedAtMs})
          ON CONFLICT DO NOTHING
          RETURNING id
        `);
        return rowsOf(inserted).length === 1 ? "opened" : "duplicate";
      });
    } catch {
      return "store_unavailable";
    }
  }

  async settle(input: {
    id: string;
    settlementResult: "yes" | "no";
    settledAtMs: number;
  }): Promise<boolean> {
    if (!input.id || !nonnegativeSafe(input.settledAtMs)) return false;
    try {
      const result = await this.db.execute(sql`
        UPDATE a2_baseline_reversion_shadow_claims
        SET state='shadow_settled',
            settlement_result=${input.settlementResult},
            settled_at_ms=${input.settledAtMs},
            updated_at_ms=${input.settledAtMs},
            updated_at=now()
        WHERE id=${input.id}
          AND state='shadow_open'
        RETURNING id
      `);
      return rowsOf(result).length === 1;
    } catch {
      return false;
    }
  }
}
