import { sql } from "drizzle-orm";

export const BK_SHADOW_CAPITAL_COORDINATOR_MODE = "shadow" as const;
export const BK_CAPITAL_ADVISORY_LOCK_NAMESPACE = 42016;

export type BkServiceLetter = "B" | "C" | "D" | "E" | "F" | "G" | "H" | "I" | "J" | "K";
export type BkInflightCapitalState =
  | "inflight"
  | "accepted_pending_refresh"
  | "submission_unknown"
  | "released";

export interface BkInflightCapitalReservation {
  id: string;
  service: BkServiceLetter;
  strategy: string;
  ticker: string;
  clientOrderId: string;
  exchangeIndex: number;
  requestedRiskCents: number;
  state: BkInflightCapitalState;
  createdAtMs: number;
  updatedAtMs: number;
  exchangeOrderId: string | null;
  lastRecoveryReason: string | null;
}

export interface BkFreshBalanceRead {
  availableBalanceCents: number;
  observedAtMs: number;
  stale: false;
}

export interface BkShadowCapitalDecisionEvent {
  mode: typeof BK_SHADOW_CAPITAL_COORDINATOR_MODE;
  service: BkServiceLetter;
  strategy: string;
  ticker: string;
  exchangeIndex: number;
  availableBalanceCents: number | null;
  balanceObservedAtMs: number | null;
  inflightReservedCents: number | null;
  requestedRiskCents: number;
  freeCapitalCents: number | null;
  decision: "shadow_allow" | "shadow_block" | "shadow_unavailable";
  orderResult: "not_attempted_shadow";
  reason:
    | "sufficient_fresh_available_balance"
    | "insufficient_fresh_available_balance"
    | "invalid_input"
    | "fresh_balance_unavailable"
    | "reservation_store_unavailable";
  reservationId: string | null;
}

export interface BkShadowAdmissionInput {
  id: string;
  service: BkServiceLetter;
  strategy: string;
  ticker: string;
  clientOrderId: string;
  exchangeIndex: number;
  requestedRiskCents: number;
  nowMs?: number;
}

export interface BkShadowCapitalStore {
  ensureSchema(): Promise<void>;
  withExchangeAdmissionLock<T>(exchangeIndex: number, fn: (locked: BkShadowLockedStore) => Promise<T>): Promise<T>;
  transitionState(input: {
    id: string;
    from: BkInflightCapitalState | BkInflightCapitalState[];
    to: BkInflightCapitalState;
    updatedAtMs: number;
    exchangeOrderId?: string | null;
    lastRecoveryReason?: string | null;
  }): Promise<boolean>;
  getById(id: string): Promise<BkInflightCapitalReservation | null>;
}

export interface BkShadowLockedStore {
  sumActiveRiskCents(exchangeIndex: number): Promise<number>;
  insertInflight(input: BkInflightCapitalReservation): Promise<boolean>;
}

export type BkFreshBalanceReader = (exchangeIndex: number) => Promise<BkFreshBalanceRead>;
export type BkCapitalDecisionLogger = (event: BkShadowCapitalDecisionEvent) => void;

const ACTIVE_CAPITAL_STATES: readonly BkInflightCapitalState[] = [
  "inflight",
  "accepted_pending_refresh",
  "submission_unknown",
] as const;

function validNonnegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validAdmissionInput(input: BkShadowAdmissionInput): boolean {
  return input.id.length > 0
    && /^[B-K]$/.test(input.service)
    && input.strategy.length > 0
    && /^KXETH15M-/.test(input.ticker)
    && input.clientOrderId.length > 0
    && validNonnegativeSafeInteger(input.exchangeIndex)
    && Number.isSafeInteger(input.requestedRiskCents)
    && input.requestedRiskCents > 0;
}

export function calculateBkShadowFreeCapital(input: {
  availableBalanceCents: number;
  inflightReservedCents: number;
}): number | null {
  if (!validNonnegativeSafeInteger(input.availableBalanceCents)
    || !validNonnegativeSafeInteger(input.inflightReservedCents)) return null;
  return input.availableBalanceCents - input.inflightReservedCents;
}

/**
 * SHADOW-ONLY implementation of the approved B-K capital policy.
 *
 * This module is intentionally not imported by any live B-K submit path.
 * It must not submit/cancel orders or change strategy decisions.
 *
 * Admission formula:
 *   free_capital =
 *     fresh same-exchange-index Kalshi available balance
 *     - same-exchange-index short-lived in-flight reservations
 *
 * No A/future-martingale reserve, fixed safety reserve, or persistent
 * unresolved-order risk participates in this formula.
 */
export async function shadowAcquireBkCapitalReservation(input: {
  admission: BkShadowAdmissionInput;
  store: BkShadowCapitalStore;
  readFreshBalance: BkFreshBalanceReader;
  logDecision?: BkCapitalDecisionLogger;
}): Promise<{ event: BkShadowCapitalDecisionEvent; reservation: BkInflightCapitalReservation | null }> {
  const { admission, store, readFreshBalance, logDecision } = input;
  const base = {
    mode: BK_SHADOW_CAPITAL_COORDINATOR_MODE,
    service: admission.service,
    strategy: admission.strategy,
    ticker: admission.ticker,
    exchangeIndex: admission.exchangeIndex,
    requestedRiskCents: admission.requestedRiskCents,
    orderResult: "not_attempted_shadow",
  } as const;

  if (!validAdmissionInput(admission)) {
    const event: BkShadowCapitalDecisionEvent = {
      ...base,
      availableBalanceCents: null,
      balanceObservedAtMs: null,
      inflightReservedCents: null,
      freeCapitalCents: null,
      decision: "shadow_unavailable",
      reason: "invalid_input",
      reservationId: null,
    };
    logDecision?.(event);
    return { event, reservation: null };
  }

  try {
    return await store.withExchangeAdmissionLock(admission.exchangeIndex, async (locked) => {
      let balance: BkFreshBalanceRead;
      try {
        balance = await readFreshBalance(admission.exchangeIndex);
      } catch {
        const event: BkShadowCapitalDecisionEvent = {
          ...base,
          availableBalanceCents: null,
          balanceObservedAtMs: null,
          inflightReservedCents: null,
          freeCapitalCents: null,
          decision: "shadow_unavailable",
          reason: "fresh_balance_unavailable",
          reservationId: null,
        };
        logDecision?.(event);
        return { event, reservation: null };
      }
      if (balance.stale !== false
        || !validNonnegativeSafeInteger(balance.availableBalanceCents)
        || !validNonnegativeSafeInteger(balance.observedAtMs)) {
        const event: BkShadowCapitalDecisionEvent = {
          ...base,
          availableBalanceCents: null,
          balanceObservedAtMs: null,
          inflightReservedCents: null,
          freeCapitalCents: null,
          decision: "shadow_unavailable",
          reason: "fresh_balance_unavailable",
          reservationId: null,
        };
        logDecision?.(event);
        return { event, reservation: null };
      }

      const inflightReservedCents = await locked.sumActiveRiskCents(admission.exchangeIndex);
      const freeCapitalCents = calculateBkShadowFreeCapital({
        availableBalanceCents: balance.availableBalanceCents,
        inflightReservedCents,
      });
      if (freeCapitalCents == null) {
        const event: BkShadowCapitalDecisionEvent = {
          ...base,
          availableBalanceCents: balance.availableBalanceCents,
          balanceObservedAtMs: balance.observedAtMs,
          inflightReservedCents: null,
          freeCapitalCents: null,
          decision: "shadow_unavailable",
          reason: "reservation_store_unavailable",
          reservationId: null,
        };
        logDecision?.(event);
        return { event, reservation: null };
      }

      if (freeCapitalCents < admission.requestedRiskCents) {
        const event: BkShadowCapitalDecisionEvent = {
          ...base,
          availableBalanceCents: balance.availableBalanceCents,
          balanceObservedAtMs: balance.observedAtMs,
          inflightReservedCents,
          freeCapitalCents,
          decision: "shadow_block",
          reason: "insufficient_fresh_available_balance",
          reservationId: null,
        };
        logDecision?.(event);
        return { event, reservation: null };
      }

      const nowMs = admission.nowMs ?? Date.now();
      const reservation: BkInflightCapitalReservation = {
        id: admission.id,
        service: admission.service,
        strategy: admission.strategy,
        ticker: admission.ticker,
        clientOrderId: admission.clientOrderId,
        exchangeIndex: admission.exchangeIndex,
        requestedRiskCents: admission.requestedRiskCents,
        state: "inflight",
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
        exchangeOrderId: null,
        lastRecoveryReason: null,
      };
      if (!(await locked.insertInflight(reservation))) {
        const event: BkShadowCapitalDecisionEvent = {
          ...base,
          availableBalanceCents: balance.availableBalanceCents,
          balanceObservedAtMs: balance.observedAtMs,
          inflightReservedCents,
          freeCapitalCents,
          decision: "shadow_unavailable",
          reason: "reservation_store_unavailable",
          reservationId: null,
        };
        logDecision?.(event);
        return { event, reservation: null };
      }

      const event: BkShadowCapitalDecisionEvent = {
        ...base,
        availableBalanceCents: balance.availableBalanceCents,
        balanceObservedAtMs: balance.observedAtMs,
        inflightReservedCents,
        freeCapitalCents,
        decision: "shadow_allow",
        reason: "sufficient_fresh_available_balance",
        reservationId: reservation.id,
      };
      logDecision?.(event);
      return { event, reservation };
    });
  } catch {
    const event: BkShadowCapitalDecisionEvent = {
      ...base,
      availableBalanceCents: null,
      balanceObservedAtMs: null,
      inflightReservedCents: null,
      freeCapitalCents: null,
      decision: "shadow_unavailable",
      reason: "reservation_store_unavailable",
      reservationId: null,
    };
    logDecision?.(event);
    return { event, reservation: null };
  }
}

export async function shadowMarkBkAcceptedPendingRefresh(input: {
  store: BkShadowCapitalStore;
  reservationId: string;
  exchangeOrderId: string;
  nowMs?: number;
}): Promise<boolean> {
  if (!input.reservationId || !input.exchangeOrderId) return false;
  return input.store.transitionState({
    id: input.reservationId,
    from: "inflight",
    to: "accepted_pending_refresh",
    exchangeOrderId: input.exchangeOrderId,
    updatedAtMs: input.nowMs ?? Date.now(),
    lastRecoveryReason: "authoritative_exchange_accept",
  });
}

export async function shadowMarkBkSubmissionUnknown(input: {
  store: BkShadowCapitalStore;
  reservationId: string;
  reason: string;
  nowMs?: number;
}): Promise<boolean> {
  if (!input.reservationId || !input.reason) return false;
  return input.store.transitionState({
    id: input.reservationId,
    from: ["inflight", "accepted_pending_refresh"],
    to: "submission_unknown",
    updatedAtMs: input.nowMs ?? Date.now(),
    lastRecoveryReason: input.reason,
  });
}

export async function shadowReleaseBkCapitalReservation(input: {
  store: BkShadowCapitalStore;
  reservationId: string;
  reason: string;
  nowMs?: number;
}): Promise<boolean> {
  if (!input.reservationId || !input.reason) return false;
  return input.store.transitionState({
    id: input.reservationId,
    from: ["inflight", "accepted_pending_refresh", "submission_unknown"],
    to: "released",
    updatedAtMs: input.nowMs ?? Date.now(),
    lastRecoveryReason: input.reason,
  });
}

/**
 * An accepted order keeps its local anti-race reservation only until one fresh,
 * same-shard balance read succeeds after authoritative acceptance. At that point
 * Kalshi's available balance is again the capital authority and the local
 * anti-race reservation is released.
 */
export async function shadowRefreshAcceptedBkReservation(input: {
  store: BkShadowCapitalStore;
  reservationId: string;
  readFreshBalance: BkFreshBalanceReader;
  nowMs?: number;
}): Promise<boolean> {
  const row = await input.store.getById(input.reservationId);
  if (!row || row.state !== "accepted_pending_refresh" || !row.exchangeOrderId) return false;
  try {
    const balance = await input.readFreshBalance(row.exchangeIndex);
    if (balance.stale !== false
      || !validNonnegativeSafeInteger(balance.availableBalanceCents)
      || !validNonnegativeSafeInteger(balance.observedAtMs)) return false;
  } catch {
    return false;
  }
  return shadowReleaseBkCapitalReservation({
    store: input.store,
    reservationId: input.reservationId,
    reason: "fresh_same_shard_balance_confirmed_after_accept",
    nowMs: input.nowMs,
  });
}

type DbLike = {
  execute: (query: unknown) => Promise<unknown>;
  transaction: <T>(fn: (tx: DbLike) => Promise<T>) => Promise<T>;
};

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  return ((result as { rows?: Array<Record<string, unknown>> })?.rows ?? []);
}

function parseReservationRow(row: Record<string, unknown>): BkInflightCapitalReservation | null {
  const service = String(row["service"] ?? "") as BkServiceLetter;
  const state = String(row["state"] ?? "") as BkInflightCapitalState;
  const exchangeIndex = Number(row["exchange_index"]);
  const requestedRiskCents = Number(row["requested_risk_cents"]);
  const createdAtMs = Number(row["created_at_ms"]);
  const updatedAtMs = Number(row["updated_at_ms"]);
  if (!/^[B-K]$/.test(service)
    || ![...ACTIVE_CAPITAL_STATES, "released"].includes(state)
    || !validNonnegativeSafeInteger(exchangeIndex)
    || !Number.isSafeInteger(requestedRiskCents) || requestedRiskCents <= 0
    || !validNonnegativeSafeInteger(createdAtMs)
    || !validNonnegativeSafeInteger(updatedAtMs)) return null;
  return {
    id: String(row["id"] ?? ""),
    service,
    strategy: String(row["strategy"] ?? ""),
    ticker: String(row["ticker"] ?? ""),
    clientOrderId: String(row["client_order_id"] ?? ""),
    exchangeIndex,
    requestedRiskCents,
    state,
    createdAtMs,
    updatedAtMs,
    exchangeOrderId: typeof row["exchange_order_id"] === "string" ? row["exchange_order_id"] : null,
    lastRecoveryReason: typeof row["last_recovery_reason"] === "string" ? row["last_recovery_reason"] : null,
  };
}

/**
 * Additive durable store. Merely importing this class has no DB side effects.
 * No live runtime currently constructs it.
 */
export class PostgresBkShadowCapitalStore implements BkShadowCapitalStore {
  constructor(private readonly db: DbLike) {}

  async ensureSchema(): Promise<void> {
    await this.db.execute(sql`
      CREATE TABLE IF NOT EXISTS eth_inflight_capital_reservations (
        id TEXT PRIMARY KEY,
        service TEXT NOT NULL CHECK (service IN ('B','C','D','E','F','G','H','I','J','K')),
        strategy TEXT NOT NULL,
        ticker TEXT NOT NULL,
        client_order_id TEXT NOT NULL UNIQUE,
        exchange_index INTEGER NOT NULL CHECK (exchange_index >= 0),
        requested_risk_cents INTEGER NOT NULL CHECK (requested_risk_cents > 0),
        state TEXT NOT NULL CHECK (state IN ('inflight','accepted_pending_refresh','submission_unknown','released')),
        created_at_ms BIGINT NOT NULL,
        updated_at_ms BIGINT NOT NULL,
        exchange_order_id TEXT,
        last_recovery_reason TEXT
      )
    `);
    await this.db.execute(sql`
      CREATE INDEX IF NOT EXISTS eth_inflight_capital_reservations_active_idx
      ON eth_inflight_capital_reservations (exchange_index, state, created_at_ms)
      WHERE state IN ('inflight','accepted_pending_refresh','submission_unknown')
    `);
  }

  async withExchangeAdmissionLock<T>(
    exchangeIndex: number,
    fn: (locked: BkShadowLockedStore) => Promise<T>,
  ): Promise<T> {
    if (!validNonnegativeSafeInteger(exchangeIndex)) throw new Error("invalid exchange index");
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${BK_CAPITAL_ADVISORY_LOCK_NAMESPACE}, ${exchangeIndex})`);
      const locked: BkShadowLockedStore = {
        sumActiveRiskCents: async (targetExchangeIndex) => {
          if (targetExchangeIndex !== exchangeIndex) throw new Error("exchange index changed while locked");
          const result = await tx.execute(sql`
            SELECT COALESCE(SUM(requested_risk_cents), 0)::bigint AS reserved_cents
            FROM eth_inflight_capital_reservations
            WHERE exchange_index=${exchangeIndex}
              AND state IN ('inflight','accepted_pending_refresh','submission_unknown')
          `);
          const raw = rowsOf(result)[0]?.["reserved_cents"] ?? 0;
          const amount = Number(raw);
          if (!validNonnegativeSafeInteger(amount)) throw new Error("invalid in-flight reserve sum");
          return amount;
        },
        insertInflight: async (reservation) => {
          if (reservation.exchangeIndex !== exchangeIndex || reservation.state !== "inflight") return false;
          const result = await tx.execute(sql`
            INSERT INTO eth_inflight_capital_reservations
              (id, service, strategy, ticker, client_order_id, exchange_index,
               requested_risk_cents, state, created_at_ms, updated_at_ms,
               exchange_order_id, last_recovery_reason)
            VALUES
              (${reservation.id}, ${reservation.service}, ${reservation.strategy}, ${reservation.ticker},
               ${reservation.clientOrderId}, ${reservation.exchangeIndex}, ${reservation.requestedRiskCents},
               'inflight', ${reservation.createdAtMs}, ${reservation.updatedAtMs}, NULL, NULL)
            ON CONFLICT DO NOTHING
            RETURNING id
          `);
          return rowsOf(result).length === 1;
        },
      };
      return fn(locked);
    });
  }

  async transitionState(input: {
    id: string;
    from: BkInflightCapitalState | BkInflightCapitalState[];
    to: BkInflightCapitalState;
    updatedAtMs: number;
    exchangeOrderId?: string | null;
    lastRecoveryReason?: string | null;
  }): Promise<boolean> {
    const fromStates = Array.isArray(input.from) ? input.from : [input.from];
    if (!input.id || fromStates.length === 0 || !validNonnegativeSafeInteger(input.updatedAtMs)) return false;
    const result = await this.db.execute(sql`
      UPDATE eth_inflight_capital_reservations
      SET state=${input.to},
          updated_at_ms=${input.updatedAtMs},
          exchange_order_id=COALESCE(${input.exchangeOrderId ?? null}, exchange_order_id),
          last_recovery_reason=${input.lastRecoveryReason ?? null}
      WHERE id=${input.id}
        AND state = ANY(${fromStates})
      RETURNING id
    `);
    return rowsOf(result).length === 1;
  }

  async getById(id: string): Promise<BkInflightCapitalReservation | null> {
    if (!id) return null;
    const result = await this.db.execute(sql`
      SELECT id, service, strategy, ticker, client_order_id, exchange_index,
             requested_risk_cents, state, created_at_ms, updated_at_ms,
             exchange_order_id, last_recovery_reason
      FROM eth_inflight_capital_reservations
      WHERE id=${id}
      LIMIT 1
    `);
    const row = rowsOf(result)[0];
    return row ? parseReservationRow(row) : null;
  }
}
