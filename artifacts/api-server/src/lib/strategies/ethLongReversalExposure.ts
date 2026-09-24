import { sql } from "drizzle-orm";

export const ETH_LONG_REVERSAL_BUCKET = "ETH_15M_LONG_REVERSAL" as const;
export const ETH_LONG_REVERSAL_CAP_ENV = "ETH_LONG_REVERSAL_SHARED_CAP_CENTS" as const;
export const ETH_LONG_REVERSAL_ADVISORY_LOCK = 42017001;

export type EthLongReversalService = "E" | "H" | "I" | "L";
export type EthLongReversalState =
  | "reserved"
  | "submitted"
  | "submission_unknown"
  | "filled_unsettled"
  | "released"
  | "settled"
  | "rejected";

export interface EthLongReversalReservation {
  id: string;
  bucket: typeof ETH_LONG_REVERSAL_BUCKET;
  service: EthLongReversalService;
  strategy: string;
  ticker: string;
  clientOrderId: string;
  sourceOrderId: string | null;
  exchangeIndex: number;
  requestedRiskCents: number;
  state: EthLongReversalState;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface EthLongReversalLockedStore {
  sumActiveRiskCents(): Promise<number>;
  insertReservation(reservation: EthLongReversalReservation): Promise<boolean>;
}

export interface EthLongReversalStore {
  withAdmissionLock<T>(fn: (locked: EthLongReversalLockedStore) => Promise<T>): Promise<T>;
  transition(input: {
    id: string;
    from: EthLongReversalState | EthLongReversalState[];
    to: EthLongReversalState;
    updatedAtMs: number;
  }): Promise<boolean>;
}

export type EthLongReversalAdmissionDecision =
  | {
      allowed: true;
      reason: "admitted";
      currentExposureCents: number;
      proposedExposureCents: number;
      postTradeExposureCents: number;
      capCents: number;
      reservation: EthLongReversalReservation;
    }
  | {
      allowed: false;
      reason: "invalid_input" | "cap_unconfigured" | "cap_exceeded" | "reservation_conflict" | "store_unavailable";
      currentExposureCents: number | null;
      proposedExposureCents: number;
      postTradeExposureCents: number | null;
      capCents: number | null;
      reservation: null;
    };

const ACTIVE_STATES: readonly EthLongReversalState[] = [
  "reserved",
  "submitted",
  "submission_unknown",
  "filled_unsettled",
];

function nonnegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function positiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

/**
 * E and H are long-reversal YES services. I participates only on its downside
 * branch, identified by generated side YES. L is always YES.
 */
export function isEthLongReversalExposure(
  service: EthLongReversalService,
  side: "yes" | "no",
): boolean {
  if (service === "I") return side === "yes";
  return side === "yes";
}

export function readEthLongReversalCapCents(
  env: NodeJS.ProcessEnv = process.env,
): number | null {
  const raw = env[ETH_LONG_REVERSAL_CAP_ENV];
  if (raw == null || raw.trim() === "") return null;
  const cap = Number(raw);
  return positiveSafeInteger(cap) ? cap : null;
}

export async function acquireEthLongReversalExposure(input: {
  id: string;
  service: EthLongReversalService;
  strategy: string;
  ticker: string;
  side: "yes" | "no";
  clientOrderId: string;
  sourceOrderId?: string | null;
  exchangeIndex: number;
  requestedRiskCents: number;
  capCents: number | null;
  store: EthLongReversalStore;
  nowMs?: number;
}): Promise<EthLongReversalAdmissionDecision> {
  const valid = input.id.length > 0
    && input.strategy.length > 0
    && /^KXETH15M-/.test(input.ticker)
    && input.clientOrderId.length > 0
    && nonnegativeSafeInteger(input.exchangeIndex)
    && positiveSafeInteger(input.requestedRiskCents)
    && isEthLongReversalExposure(input.service, input.side);

  if (!valid) {
    return {
      allowed: false, reason: "invalid_input", currentExposureCents: null,
      proposedExposureCents: input.requestedRiskCents, postTradeExposureCents: null,
      capCents: input.capCents, reservation: null,
    };
  }
  if (input.capCents == null || !positiveSafeInteger(input.capCents)) {
    return {
      allowed: false, reason: "cap_unconfigured", currentExposureCents: null,
      proposedExposureCents: input.requestedRiskCents, postTradeExposureCents: null,
      capCents: null, reservation: null,
    };
  }

  try {
    return await input.store.withAdmissionLock(async (locked) => {
      const currentExposureCents = await locked.sumActiveRiskCents();
      if (!nonnegativeSafeInteger(currentExposureCents)) {
        return {
          allowed: false, reason: "store_unavailable", currentExposureCents: null,
          proposedExposureCents: input.requestedRiskCents, postTradeExposureCents: null,
          capCents: input.capCents!, reservation: null,
        };
      }
      const postTradeExposureCents = currentExposureCents + input.requestedRiskCents;
      if (!Number.isSafeInteger(postTradeExposureCents)) {
        return {
          allowed: false, reason: "invalid_input", currentExposureCents,
          proposedExposureCents: input.requestedRiskCents, postTradeExposureCents: null,
          capCents: input.capCents!, reservation: null,
        };
      }
      if (postTradeExposureCents > input.capCents!) {
        return {
          allowed: false, reason: "cap_exceeded", currentExposureCents,
          proposedExposureCents: input.requestedRiskCents, postTradeExposureCents,
          capCents: input.capCents!, reservation: null,
        };
      }

      const nowMs = input.nowMs ?? Date.now();
      const reservation: EthLongReversalReservation = {
        id: input.id,
        bucket: ETH_LONG_REVERSAL_BUCKET,
        service: input.service,
        strategy: input.strategy,
        ticker: input.ticker,
        clientOrderId: input.clientOrderId,
        sourceOrderId: input.sourceOrderId ?? null,
        exchangeIndex: input.exchangeIndex,
        requestedRiskCents: input.requestedRiskCents,
        state: "reserved",
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
      };
      if (!(await locked.insertReservation(reservation))) {
        return {
          allowed: false, reason: "reservation_conflict", currentExposureCents,
          proposedExposureCents: input.requestedRiskCents, postTradeExposureCents,
          capCents: input.capCents!, reservation: null,
        };
      }
      return {
        allowed: true, reason: "admitted", currentExposureCents,
        proposedExposureCents: input.requestedRiskCents, postTradeExposureCents,
        capCents: input.capCents!, reservation,
      };
    });
  } catch {
    return {
      allowed: false, reason: "store_unavailable", currentExposureCents: null,
      proposedExposureCents: input.requestedRiskCents, postTradeExposureCents: null,
      capCents: input.capCents, reservation: null,
    };
  }
}

type DbLike = {
  execute: (query: unknown) => Promise<unknown>;
  transaction: <T>(fn: (tx: DbLike) => Promise<T>) => Promise<T>;
};

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  const rows = (result as { rows?: Array<Record<string, unknown>> } | null)?.rows;
  return Array.isArray(rows) ? rows : [];
}

export class PostgresEthLongReversalStore implements EthLongReversalStore {
  constructor(private readonly db: DbLike) {}

  async withAdmissionLock<T>(fn: (locked: EthLongReversalLockedStore) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${ETH_LONG_REVERSAL_ADVISORY_LOCK})`);
      const locked: EthLongReversalLockedStore = {
        sumActiveRiskCents: async () => {
          const result = await tx.execute(sql`
            SELECT COALESCE(SUM(requested_risk_cents), 0)::bigint AS active_risk_cents
            FROM eth_long_reversal_reservations
            WHERE bucket=${ETH_LONG_REVERSAL_BUCKET}
              AND state IN ('reserved','submitted','submission_unknown','filled_unsettled')
          `);
          const value = Number(rowsOf(result)[0]?.["active_risk_cents"] ?? 0);
          if (!nonnegativeSafeInteger(value)) throw new Error("invalid long-reversal exposure sum");
          return value;
        },
        insertReservation: async (reservation) => {
          const result = await tx.execute(sql`
            INSERT INTO eth_long_reversal_reservations
              (id,bucket,service,strategy,ticker,client_order_id,source_order_id,exchange_index,
               requested_risk_cents,state,created_at_ms,updated_at_ms)
            VALUES
              (${reservation.id},${reservation.bucket},${reservation.service},${reservation.strategy},
               ${reservation.ticker},${reservation.clientOrderId},${reservation.sourceOrderId},
               ${reservation.exchangeIndex},${reservation.requestedRiskCents},'reserved',
               ${reservation.createdAtMs},${reservation.updatedAtMs})
            ON CONFLICT DO NOTHING
            RETURNING id
          `);
          return rowsOf(result).length === 1;
        },
      };
      return fn(locked);
    });
  }

  async transition(input: {
    id: string;
    from: EthLongReversalState | EthLongReversalState[];
    to: EthLongReversalState;
    updatedAtMs: number;
  }): Promise<boolean> {
    const from = Array.isArray(input.from) ? input.from : [input.from];
    if (!input.id || from.length === 0 || !nonnegativeSafeInteger(input.updatedAtMs)) return false;
    const result = await this.db.execute(sql`
      UPDATE eth_long_reversal_reservations
      SET state=${input.to}, updated_at_ms=${input.updatedAtMs}
      WHERE id=${input.id} AND state = ANY(${from})
      RETURNING id
    `);
    return rowsOf(result).length === 1;
  }
}

export function activeEthLongReversalStates(): readonly EthLongReversalState[] {
  return ACTIVE_STATES;
}
