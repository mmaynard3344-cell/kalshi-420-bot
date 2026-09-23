/**
 * ETH 420 candidate. Its live executor has a fully separate order ledger and
 * never shares a lifecycle, table, or gateway with ethOnlyMartingale.
 */
import { advanceEth420CandidateSequence } from "./eth420CandidateState.js";
import { kalshiAuthFetch } from "../kalshiAuth.js";
import { fetchFreshKalshiBalanceForExchangeRead, kalshiBalanceCents } from "../kalshiBalance.js";
import { parseKalshiOrderResponse } from "../orderResponseParser.js";
import { addDecimalStrings, normalizeKalshiFill } from "../kalshiFillNormalizer.js";
import { logger } from "../logger.js";
import { scheduleEth420CandidateExecutionTelemetry } from "../eth420ExecutionTelemetry.js";
import { captureOrderbook, parseExitSellBids, parseOrderbookResponse } from "../orderbookCapture.js";
import { ETH420_SECONDARY_ENTRY_MAX_ASK_CENTS, tryEth420SecondaryEntry, isEth420SecondaryEntryPermitted } from "./eth420SecondaryEntry.js";
import {
  fetchCompleteEth15mSettledHistory,
  kalshiSeriesFetch,
  type KalshiEth15mHistoricalFact,
} from "../kalshi.js";
type CandidateAuthFetch = typeof kalshiAuthFetch;
let candidateAuthFetch: CandidateAuthFetch = kalshiAuthFetch;
type CandidateBalanceRead = typeof fetchFreshKalshiBalanceForExchangeRead;
let candidateBalanceRead: CandidateBalanceRead = fetchFreshKalshiBalanceForExchangeRead;
type CandidateOrderbookCapture = typeof captureOrderbook;
let candidateOrderbookCapture: CandidateOrderbookCapture = captureOrderbook;
/** Test seam for candidate exchange recovery only; it does not affect the
 * shared authenticated gateway or any legacy strategy. */
export function _setEth420CandidateAuthFetchForTesting(fetcher: CandidateAuthFetch | null): void {
  candidateAuthFetch = fetcher ?? kalshiAuthFetch;
}
/** Test seam for the candidate's routed-balance preflight only. */
export function _setEth420CandidateBalanceReadForTesting(reader: CandidateBalanceRead | null): void {
  candidateBalanceRead = reader ?? fetchFreshKalshiBalanceForExchangeRead;
}
/** Test-only seam for the one-window Back Flip's first post-settlement B book read. */
export function _setEth420CandidateOrderbookCaptureForTesting(reader: CandidateOrderbookCapture | null): void {
  candidateOrderbookCapture = reader ?? captureOrderbook;
}
export const ETH_420_CANDIDATE_LABEL = "ETH_420_6_STEP_RESET_SHADOW_ONLY";
export const ETH_420_PRINCIPALS_CENTS = [50, 50, 50, 100, 250, 300] as const;
export const ETH_420_OVERRIDE_CENTS = 420;
/** Retained-side (≥50¢) Back Flip entries cross the chosen-side ask up to $420. */
export const ETH_420_BACK_FLIP_RETAIN_WAGER_CENTS = 420;
/** Flipped-side (<50¢) Back Flip entries retain their isolated $25 resting wager. */
export const ETH_420_BACK_FLIP_FLIP_WAGER_CENTS = 25;
export const ETH_420_DAILY_LOSS_LIMIT_CENTS = -1200;
export const ETH_420_HISTORY_DAYS = 28;
export const ETH_420_MIN_HISTORY = 50;
export const ETH_420_LIVE_LIMIT_PRICE_CENTS = 50;
/** A finalized candidate still unresolved after this interval needs operator visibility.
 * This is observability only; it does not alter recovery, settlement, or execution. */
export const ETH_420_FINALIZED_RECONCILIATION_ALERT_THRESHOLD_MS = 2 * 60_000;
/**
 * Hard production fence. An environment setting alone can never enable ETH
 * 420; changing this requires an explicit, separately reviewed code change
 * after execution-readiness requirements have been met.
 */
export const ETH_420_CANDIDATE_EXECUTION_APPROVED = true;

export function isEth420CandidateExecutionPermitted(): boolean {
  return ETH_420_CANDIDATE_EXECUTION_APPROVED
    && process.env["ETH_420_CANDIDATE_LIVE_ENABLED"] === "true";
}

export type Eth420Side = "yes" | "no";
export function selectEth420BackFlipSide(missedSide: Eth420Side, missedSideBidCents: number): Eth420Side | null {
  if (!["yes", "no"].includes(missedSide) || !Number.isInteger(missedSideBidCents)
    || missedSideBidCents < 0 || missedSideBidCents > 100) return null;
  return missedSideBidCents >= 50 ? missedSide : missedSide === "yes" ? "no" : "yes";
}

/** Whole-contract retained-side IOC quantity that never exceeds the $420 Back Flip risk cap. */
export function eth420BackFlipIocContracts(chosenSideAskCents: number): number | null {
  if (!Number.isInteger(chosenSideAskCents) || chosenSideAskCents < 1 || chosenSideAskCents > 99) return null;
  const contracts = Math.floor(ETH_420_BACK_FLIP_RETAIN_WAGER_CENTS / chosenSideAskCents);
  return contracts >= 1 ? contracts : null;
}
/** Pure exchange-side mapping for the operator-only emergency action.  Kalshi
 * nets NO by buying YES, so a NO exit is always a YES-book bid, never an ask. */
export function eth420EmergencyReductionInstruction(
  heldSide: Eth420Side, executableYesBidCents: number, executableYesAskCents = executableYesBidCents,
): {
  side: "ask" | "bid"; limitPriceCents: number;
} | null {
  const price = heldSide === "yes" ? executableYesBidCents : executableYesAskCents;
  if (!Number.isInteger(price) || price < 1 || price > 99) return null;
  return { side: heldSide === "yes" ? "ask" : "bid", limitPriceCents: price };
}
export type Eth420CandidateRecoveryOutcome =
  | "not_terminal" | "exchange_order_not_found" | "exchange_evidence_ambiguous"
  | "authenticated_fill_missing" | "economics_incomplete" | "official_result_missing"
  | "earlier_candidate_unresolved" | "persisted_state_read_failed" | "bootstrap_not_allowed"
  | "stale_state_retry" | "settled" | "unexpected_error";
export interface Eth420State {
  easternDate: string;
  side: Eth420Side;
  step: number;
  realizedPnlCents: number;
  lastBlockResetAtMs: number | null;
}
export interface Eth420StrikeObservation {
  ticker: string;
  easternDate: string;
  observedAtMs: number;
  floorStrike: number | null;
  /** The authoritative market-open timestamp establishes real 15-minute adjacency. */
  openTimeMs: number | null;
}
export interface Eth420EvaluationInput {
  ticker: string;
  easternDate: string;
  observedAtMs: number;
  floorStrike: number | null;
  openTimeMs: number | null;
  priorMarket: Eth420StrikeObservation | null;
  trailingMoves: Array<number | null | undefined>;
  state: Eth420State;
  estimatedFeeCents: number;
  /** Read-only source attribution for evaluation observability. */
  bootstrapObservationCount?: number;
  liveTelemetryObservationCount?: number;
}
export interface Eth420Decision {
  label: typeof ETH_420_CANDIDATE_LABEL;
  ticker: string;
  side: Eth420Side;
  underlyingStep: number;
  normalWagerCents: number;
  effectiveWagerCents: number;
  validObservationCount: number;
  p95: number | null;
  p99: number | null;
  currentMove: number | null;
  atOrAboveP95: boolean | null;
  belowP99: boolean | null;
  sweetSpotTell: boolean;
  overrideIncreasedWager: boolean;
  resultingBand: "unavailable" | "below_p95" | "p95_to_p99" | "at_or_above_p99";
  bootstrapObservationCount: number;
  liveTelemetryObservationCount: number;
  prospectiveWorstCasePnlCents: number;
  realizedPnlCents: number;
  prospectiveLossAllowed: boolean;
  blockResetApplied: boolean;
  finalReason: string;
  nextState: Eth420State;
}
export interface Eth420CandidateTelemetryStore {
  listEth420CandidateTelemetry(afterMs: number): Promise<Array<{
    ticker: string; easternDate: string; observedAtMs: number; floorStrike: number | null; payloadJson: string;
  }>>;
  recordEth420CandidateTelemetry(params: {
    id: string; ticker: string; easternDate: string; observedAtMs: number; floorStrike: number | null; payloadJson: string;
  }): Promise<boolean>;
  getEth420CandidateState(easternDate: string): Promise<Eth420State | null>;
  saveEth420CandidateState(state: Eth420State): Promise<boolean>;
  applyEth420CandidateConfirmedSettlement(params: {
    id: string;
    easternDate: string;
    nextState: Eth420State;
    realizedPnlDeltaCents: number;
  }): Promise<boolean>;
  recordEth420CounterfactualEntry(params: {
    id: string; ticker: string; easternDate: string; observedAtMs: number;
    side: Eth420Side; step: number; effectiveWagerCents: number; decisionPayloadJson: string;
    stateBeforeJson: string;
  }): Promise<boolean>;
}
type Eth420CandidateEvaluationStore = Pick<Eth420CandidateTelemetryStore,
  "getEth420CandidateState" | "listEth420CandidateTelemetry">;
export interface Eth420CandidateMarket {
  ticker: string; easternDate: string; observedAtMs: number; floorStrike: number | null; openTimeMs: number | null;
}

type Eth420HistoryFact = KalshiEth15mHistoricalFact & { source: "bootstrap" | "live" };
type Eth420HistoricalMove = {
  move: number;
  currentOpenTimeMs: number;
  source: "bootstrap" | "live";
};
let eth420BootstrapFacts: KalshiEth15mHistoricalFact[] = [];

/** Startup-only read of public finalized metadata. A failed fetch leaves no
 * partial contribution, and never affects entry timing or order execution. */
export async function bootstrapEth420PercentileHistory(): Promise<boolean> {
  const current = await kalshiSeriesFetch("KXETH15M", { forceFresh: true });
  const openTimeMs = current && typeof current["open_time"] === "string"
    ? Date.parse(current["open_time"])
    : NaN;
  const facts = await fetchCompleteEth15mSettledHistory(openTimeMs);
  if (!facts) {
    eth420BootstrapFacts = [];
    logger.warn("ETH 420 percentile bootstrap unavailable; retaining live telemetry only");
    return false;
  }
  eth420BootstrapFacts = facts;
  logger.info({ historicalFacts: facts.length }, "ETH 420 percentile bootstrap ready");
  return true;
}

/** Test seam; production data is populated only through the fail-closed loader. */
export function _setEth420BootstrapFactsForTesting(facts: KalshiEth15mHistoricalFact[] | null): void {
  eth420BootstrapFacts = facts ?? [];
}

export interface Eth420CandidateLiveStore extends Eth420CandidateTelemetryStore {
  getEth420CandidateBackFlipArm?: (targetOpenTimeMs: number) => Promise<import("../tradeStore.js").Eth420CandidateBackFlipArm | null>;
  fallbackEth420CandidateBackFlip?: (params: {
    sourceCandidateOrderId: string; targetTicker: string; targetOpenTimeMs: number;
    observedAtMs: number; reason: string;
  }) => Promise<boolean>;
  getEth420SecondaryActivationCutover: () => Promise<{ version: 1; activatedAtMs: number; reservationSequence?: number } | null>;
  recordEth420CandidateExecutionSnapshot: (snapshot: import("../tradeStore.js").Eth420CandidateExecutionSnapshot) => Promise<boolean>;
  listRecentUnsettledEth420CandidateLiveOrders: (sinceMs: number) => Promise<import("../tradeStore.js").Eth420CandidateLiveOrder[]>;
  getEth420CandidateLiveOrder: (id: string) => Promise<import("../tradeStore.js").Eth420CandidateLiveOrder | null>;
  claimEth420CandidateSecondaryEntryAttempt: (params: { candidateOrderId: string; attemptedAtMs: number; reservationAskCents: number | null }) => Promise<boolean>;
  recordEth420CandidateSecondaryEntryEvent: (params: {
    candidateOrderId: string; atMs: number; event: string; reason: string | null;
    reservationAskCents: number | null; currentAskCents: number | null;
    primaryOrderId?: string | null; secondaryClientOrderId?: string | null; secondaryOrderId?: string | null;
  }) => Promise<boolean>;
  replaceEth420CandidatePrimaryWithSecondary: (id: string, primaryOrderId: string, secondaryOrderId: string) => Promise<boolean>;
  markEth420CandidateSecondarySubmissionPending: (id: string, primaryOrderId: string, clientOrderId: string) => Promise<boolean>;
  recordEth420CandidateRecoveryOutcome(params: {
    id: string; outcome: Eth420CandidateRecoveryOutcome; errorClass: string | null;
  }): Promise<boolean>;
  /** Records the first confirmed official outcome boundary for read-only alerting.
   * It cannot change lifecycle state, fills, settlement, or candidate state. */
  markEth420CandidateOrderFinalized?: (id: string, finalizedAtMs: number) => Promise<boolean>;
  readPersistedEth420CandidateState(easternDate: string): Promise<{ available: boolean; state: Eth420State | null }>;
  createEth420CandidateLiveOrder(params: {
    id: string; ticker: string; easternDate: string; side: Eth420Side; step: number;
    requestedContracts: number; limitPriceCents: number; effectiveWagerCents: number; stateBeforeJson: string;
  }): Promise<boolean>;
  reserveEth420CandidateLiveOrderIfStateMatches(params: {
    id: string; ticker: string; easternDate: string; side: Eth420Side; step: number;
    requestedContracts: number; limitPriceCents: number; effectiveWagerCents: number; stateBeforeJson: string;
    expectedState: Eth420State; reservationAtMs?: number; marketOpenTimeMs?: number | null;
    backFlip?: import("../tradeStore.js").Eth420CandidateBackFlipReservation | null;
  }): Promise<boolean>;
  acknowledgeEth420CandidateLiveOrder(
    id: string, kalshiOrderId: string | null, status: string, rejectionReason?: string,
  ): Promise<boolean>;
  /** Deletes only an unbound, unknown submission after a complete authenticated
   * history scan proves it was never accepted by the exchange. */
  releaseEth420CandidateProvenAbsentSubmission(id: string): Promise<boolean>;
  settleEth420CandidateLiveOrder(params: {
    id: string; result: Eth420Side; filledContracts: number; realizedPnlDeltaCents: number; nextState: Eth420State;
    expectedState: Eth420State | null;
    actualNotionalDollars: string | null; actualFeeDollars: string | null; fillPriceCents: number | null;
  }): Promise<boolean>;
  listPendingEth420CandidateLiveOrders(): Promise<Array<{
    id: string; ticker: string; easternDate: string; kalshiOrderId: string | null; requestedContracts: number;
    limitPriceCents: number; side: Eth420Side; step: number; stateBeforeJson: string; status: string;
    createdAtMs: number;
  }>>;
}

/** A structured Kalshi validation rejection proves a POST did not create an
 * order. Only the exchange's explicit insufficient-balance code is eligible
 * for the no-exposure shortcut; malformed or proxy errors remain ambiguous. */
export function confirmedEth420InsufficientBalanceRejectionReason(err: unknown): string | null {
  if (typeof err !== "object" || err == null) return null;
  const candidate = err as { status?: unknown; body?: unknown };
  if (![400, 422].includes(Number(candidate.status))) return null;
  const response = typeof candidate.body === "object" && candidate.body != null
    ? candidate.body as Record<string, unknown>
    : null;
  const error = response?.["error"];
  const details = typeof error === "object" && error != null ? error as Record<string, unknown> : null;
  if (!details) return null;
  const reason = [details["code"], details["reason"], details["message"]]
    .find((value): value is string => typeof value === "string" && value.trim().length > 0);
  if (!reason || !/^insufficient[_\s-]?balance$/i.test(reason.trim())) return null;
  // The rejection code is normally pre-fill proof. If the response also
  // reports an execution quantity, it must expressly be zero; a nonzero or
  // malformed quantity is contradictory evidence and remains fail-closed.
  for (const source of [response, details].filter((value): value is Record<string, unknown> => value != null)) {
    for (const key of ["filled_contracts", "filled_count", "fill_count", "filled_contracts_fp", "fill_count_fp"]) {
      if (!(key in source)) continue;
      const quantity = typeof source[key] === "number" ? source[key] : Number(source[key]);
      if (!Number.isInteger(quantity) || quantity !== 0) return null;
    }
  }
  return reason.trim().slice(0, 500);
}

async function recordCandidateRecoveryOutcome(
  store: Eth420CandidateLiveStore,
  order: { id: string; ticker: string; kalshiOrderId: string | null },
  outcome: Eth420CandidateRecoveryOutcome,
  errorClass: string | null = null,
): Promise<void> {
  try {
    await store.recordEth420CandidateRecoveryOutcome({ id: order.id, outcome, errorClass });
  } catch {
    // Observability failure cannot relax recovery's fail-closed rules.
  }
  logger.info({ candidateOrderId: order.id, ticker: order.ticker, kalshiOrderId: order.kalshiOrderId,
    outcome, errorClass }, "ETH 420 candidate recovery outcome");
}

type CandidateOrderWire = Record<string, unknown>;
type CandidateFillPage = { fills?: CandidateOrderWire[]; cursor?: unknown };
export type Eth420CandidateHistoryIdentity =
  | { kind: "terminal_bound"; orderId: string; filled: number }
  | { kind: "resting_bound"; orderId: string }
  | { kind: "proven_absent" }
  | { kind: "ambiguous_retry" };

function terminalCandidateOrder(raw: CandidateOrderWire, requestedContracts: number): { orderId: string; filled: number } | null {
  const parsed = parseKalshiOrderResponse({ order: raw }, requestedContracts);
  const status = parsed.orderStatus?.toLowerCase();
  if (!parsed.kalshiOrderId || !parsed.fillCountProvided
    || !["canceled", "cancelled", "executed", "filled", "expired", "rejected"].includes(status ?? "")
    || !Number.isFinite(parsed.fillCount) || parsed.fillCount < 0 || parsed.fillCount > requestedContracts) return null;
  return { orderId: parsed.kalshiOrderId, filled: parsed.fillCount };
}

/** Finds the exchange identity for a POST whose response was lost. The match is
 * deliberately exact on both client_order_id and ticker; no guessed identity is
 * ever persisted or settled. */
function restingCandidateOrder(raw: CandidateOrderWire): string | null {
  const orderId = raw["order_id"];
  const status = typeof raw["status"] === "string" ? raw["status"].toLowerCase() : "";
  return typeof orderId === "string" && orderId !== "" && status === "resting" ? orderId : null;
}

/** Complete candidate-only authenticated history scan. Absence is returned
 * only after every order partition and the fill history have paginated to a
 * well-formed end. A fill on this ticker cannot safely be attributed away from
 * an ambiguous POST, so it is deliberately retry evidence rather than absence. */
export async function recoverEth420CandidateHistoryIdentity(order: {
  id: string; ticker: string; kalshiOrderId: string | null; originalPrimaryKalshiOrderId?: string | null; secondaryClientOrderId?: string | null; requestedContracts: number;
}): Promise<Eth420CandidateHistoryIdentity> {
  try {
    const expectedClientOrderId = order.secondaryClientOrderId ?? (
      order.originalPrimaryKalshiOrderId && order.kalshiOrderId !== order.originalPrimaryKalshiOrderId
        ? `${order.id}:secondary-v1` : order.id
    );
    const scanTerminalHistory = async (requiredOrderId: string | null): Promise<Eth420CandidateHistoryIdentity> => {
      let matched: Eth420CandidateHistoryIdentity | null = null;
      // Kalshi separates resting and historical terminal orders. Scan every
      // relevant partition to completion before declaring an unknown POST absent.
      for (const status of ["resting", "canceled", "executed", "rejected", "expired"]) {
        let cursor: string | null = null;
        const seen = new Set<string>();
        for (;;) {
          const qs = new URLSearchParams({ ticker: order.ticker, status, limit: "100" });
          if (cursor) qs.set("cursor", cursor);
          const page = await candidateAuthFetch<{ orders?: CandidateOrderWire[]; cursor?: unknown }>("GET", `/portfolio/orders?${qs}`);
          if (!Array.isArray(page.orders)) return { kind: "ambiguous_retry" };
          for (const candidate of page.orders) {
            if (!candidate || candidate["client_order_id"] !== expectedClientOrderId || candidate["ticker"] !== order.ticker) continue;
            // A bound record may use history only to recover an archived detail
            // read. It must still resolve to that exact exchange order, never a
            // different order that merely shares a client identifier.
            if (requiredOrderId != null && candidate["order_id"] !== requiredOrderId) return { kind: "ambiguous_retry" };
            const terminal = terminalCandidateOrder(candidate, order.requestedContracts);
            const identity = terminal ? { kind: "terminal_bound" as const, ...terminal } : (() => {
              const resting = restingCandidateOrder(candidate);
              return resting ? { kind: "resting_bound" as const, orderId: resting } : null;
            })();
            if (!identity) return { kind: "ambiguous_retry" };
            // Unknown submissions retain their established first exact-match
            // recovery behavior. A bound-detail 404 fallback instead scans to
            // completion so a duplicate historical identity cannot be chosen.
            if (requiredOrderId == null) return identity;
            if (matched != null) return { kind: "ambiguous_retry" };
            matched = identity;
          }
          if (page.cursor == null || page.cursor === "") break;
          if (typeof page.cursor !== "string" || seen.has(page.cursor)) return { kind: "ambiguous_retry" };
          seen.add(page.cursor); cursor = page.cursor;
        }
      }
      if (matched) return matched;
      // A bound order-detail 404 is never proof that the submitted order was
      // absent. Only lost POSTs may reach the complete-absence release path.
      if (requiredOrderId != null) return { kind: "ambiguous_retry" };
      let cursor: string | null = null;
      const seen = new Set<string>();
      for (;;) {
        // Do not rely on a ticker filter being complete/supported for fills:
        // inspect every authenticated fills page just as the legacy safety
        // contract does, then conservatively inspect this market's rows.
        const qs = new URLSearchParams({ limit: "100" });
        if (cursor) qs.set("cursor", cursor);
        const page = await candidateAuthFetch<CandidateFillPage>("GET", `/portfolio/fills?${qs}`);
        if (!Array.isArray(page.fills)) return { kind: "ambiguous_retry" };
        // An unbound submission plus any fill on its market is never proof that
        // this POST was absent, even if that fill has no client order id.
        if (page.fills.some((fill) => fill && (fill["ticker"] ?? fill["market_ticker"]) === order.ticker)) {
          return { kind: "ambiguous_retry" };
        }
        if (page.cursor == null || page.cursor === "") break;
        if (typeof page.cursor !== "string" || seen.has(page.cursor)) return { kind: "ambiguous_retry" };
        seen.add(page.cursor); cursor = page.cursor;
      }
      return { kind: "proven_absent" };
    };
    if (order.kalshiOrderId) {
      try {
        const raw = await candidateAuthFetch<Record<string, unknown>>(
          "GET", `/portfolio/orders/${encodeURIComponent(order.kalshiOrderId)}`,
        );
        const candidate = (raw["order"] as CandidateOrderWire | undefined) ?? raw;
        if (!candidate || candidate["order_id"] !== order.kalshiOrderId || candidate["client_order_id"] !== expectedClientOrderId
          || candidate["ticker"] !== order.ticker) return { kind: "ambiguous_retry" };
        const terminal = terminalCandidateOrder(candidate, order.requestedContracts);
        if (terminal) return { kind: "terminal_bound", ...terminal };
        const resting = restingCandidateOrder(candidate);
        return resting ? { kind: "resting_bound", orderId: resting } : { kind: "ambiguous_retry" };
      } catch (error) {
        // Finalized Kalshi orders can age out of the direct detail endpoint.
        // A 404 may therefore use the exact-order history fallback; all other
        // failures remain ambiguous and never relax the reservation.
        if ((error as { status?: unknown }).status !== 404) return { kind: "ambiguous_retry" };
        return scanTerminalHistory(order.kalshiOrderId);
      }
    }
    return scanTerminalHistory(null);
  } catch {
    return { kind: "ambiguous_retry" };
  }
}

async function recoverCandidateOrderIdentity(order: {
  id: string; ticker: string; kalshiOrderId: string | null; originalPrimaryKalshiOrderId?: string | null; requestedContracts: number;
}): Promise<Eth420CandidateHistoryIdentity> {
  return recoverEth420CandidateHistoryIdentity(order);
}

type CandidateOfficialOutcome = { kind: "terminal"; result: Eth420Side } | { kind: "not_terminal" | "missing" };

function parseCandidateOfficialOutcome(ticker: string, raw: CandidateOrderWire): CandidateOfficialOutcome {
  const market = (raw["market"] as CandidateOrderWire | undefined) ?? raw;
  const status = typeof market["status"] === "string" ? market["status"].toLowerCase() : "";
  const result = market["result"];
  if (market["ticker"] !== ticker || (result !== "yes" && result !== "no")) return { kind: "missing" };
  return ["closed", "settled", "finalized"].includes(status) ? { kind: "terminal", result } : { kind: "not_terminal" };
}

/** Historical final markets age out of /markets. The archive fallback is exact
 * ticker-only and bounded; it is evidence lookup, never entry discovery. */
async function candidateOfficialOutcome(ticker: string): Promise<CandidateOfficialOutcome> {
  try {
    const direct = parseCandidateOfficialOutcome(ticker,
      await candidateAuthFetch<Record<string, unknown>>("GET", `/markets/${encodeURIComponent(ticker)}`));
    if (direct.kind !== "missing") return direct;
  } catch {
    // Archived final markets return 404 from the live catalog; check archive.
  }
  const seriesTicker = ticker.split("-")[0];
  if (!seriesTicker) return { kind: "missing" };
  let cursor: string | null = null;
  const seen = new Set<string>();
  for (let pageCount = 0; pageCount < 20; pageCount++) {
    try {
      const query = new URLSearchParams({ series_ticker: seriesTicker, limit: "1000" });
      if (cursor) query.set("cursor", cursor);
      const page = await candidateAuthFetch<{ markets?: CandidateOrderWire[]; cursor?: unknown }>(
        "GET", `/historical/markets?${query}`,
      );
      if (!Array.isArray(page.markets)) return { kind: "missing" };
      const market = page.markets.find((entry) => entry && entry["ticker"] === ticker);
      if (market) return parseCandidateOfficialOutcome(ticker, market);
      if (page.cursor == null || page.cursor === "") return { kind: "missing" };
      if (typeof page.cursor !== "string" || seen.has(page.cursor)) return { kind: "missing" };
      seen.add(page.cursor); cursor = page.cursor;
    } catch {
      return { kind: "missing" };
    }
  }
  return { kind: "missing" };
}

async function candidateMarketHasClosed(ticker: string): Promise<boolean> {
  return (await candidateOfficialOutcome(ticker)).kind === "terminal";
}

async function candidateFillEconomics(order: { id: string; ticker: string; side: Eth420Side }, orderId: string, expected: number):
Promise<{ notional: string; fee: string; fillPriceCents: number } | null> {
  let cursor: string | null = null, quantity = "0", notional = "0", fee = "0", weightedCents = 0;
  const seen = new Set<string>();
  for (;;) {
    const qs = new URLSearchParams({ order_id: orderId, limit: "100" });
    if (cursor) qs.set("cursor", cursor);
    const page = await candidateAuthFetch<CandidateFillPage>("GET", `/portfolio/fills?${qs}`);
    if (!Array.isArray(page.fills)) return null;
    for (const fill of page.fills) {
      if (!fill || fill["order_id"] !== orderId || (fill["ticker"] ?? fill["market_ticker"]) !== order.ticker) return null;
      const normalized = normalizeKalshiFill(fill, order.side);
      if (!normalized || !normalized.fillId) return null; // Missing fees also fail normalization.
      quantity = addDecimalStrings(quantity, normalized.contractsExact);
      notional = addDecimalStrings(notional, normalized.exactCostDollars);
      fee = addDecimalStrings(fee, normalized.exactFeeDollars);
      weightedCents += normalized.fillPriceCents * normalized.contracts;
    }
    if (page.cursor == null || page.cursor === "") break;
    if (typeof page.cursor !== "string" || seen.has(page.cursor)) return null;
    seen.add(page.cursor); cursor = page.cursor;
  }
  const contracts = Number(quantity);
  return Number.isFinite(contracts) && contracts === expected && contracts > 0
    ? { notional, fee, fillPriceCents: Math.round(weightedCents / contracts) } : null;
}

async function verifyCandidateZeroFill(order: { id: string; ticker: string }, orderId: string): Promise<boolean> {
  if (!await candidateMarketHasClosed(order.ticker)) return false;
  let cursor: string | null = null;
  const seen = new Set<string>();
  for (;;) {
    const qs = new URLSearchParams({ order_id: orderId, limit: "100" });
    if (cursor) qs.set("cursor", cursor);
    const page = await candidateAuthFetch<CandidateFillPage>("GET", `/portfolio/fills?${qs}`);
    if (!Array.isArray(page.fills) || page.fills.length !== 0) return false;
    if (page.cursor == null || page.cursor === "") break;
    if (typeof page.cursor !== "string" || seen.has(page.cursor)) return false;
    seen.add(page.cursor); cursor = page.cursor;
  }
  const positions = await candidateAuthFetch<{ market_positions?: CandidateOrderWire[] }>(
    "GET", `/portfolio/positions?ticker=${encodeURIComponent(order.ticker)}`,
  );
  if (!Array.isArray(positions.market_positions)
    || positions.market_positions.some((position) => !position || typeof position !== "object")) return false;
  const position = positions.market_positions.find((entry) => entry["ticker"] === order.ticker);
  if (!position) return true;
  const raw = position["position_fp"] ?? position["position"];
  return (typeof raw === "number" || typeof raw === "string") && Number(raw) === 0;
}

function recordedCandidateStateBefore(order: {
  easternDate: string; side: Eth420Side; step?: number; stateBeforeJson?: string;
}): Eth420State | null {
  if (typeof order.stateBeforeJson !== "string") return null;
  try {
    const raw = JSON.parse(order.stateBeforeJson) as Record<string, unknown>;
    const step = typeof raw["step"] === "number" ? raw["step"] : NaN;
    const realizedPnlCents = typeof raw["realizedPnlCents"] === "number" ? raw["realizedPnlCents"] : NaN;
    const lastBlockResetAtMs = raw["lastBlockResetAtMs"];
    if (raw["easternDate"] !== order.easternDate || raw["side"] !== order.side
      || !Number.isInteger(step) || step < 0 || step > 5
      || (order.step != null && step !== order.step)
      || !Number.isInteger(realizedPnlCents)
      || (lastBlockResetAtMs !== null && !Number.isInteger(lastBlockResetAtMs))) return null;
    return {
      easternDate: order.easternDate, side: order.side, step, realizedPnlCents,
      lastBlockResetAtMs: lastBlockResetAtMs as number | null,
    };
  } catch {
    return null;
  }
}

/** Recovery/settlement path for a candidate-only order. It never settles until
 * terminal exchange identity and authenticated fill economics are complete. */
export async function recoverAndSettleEth420CandidateLiveOrder(
  store: Eth420CandidateLiveStore,
  order: {
    id: string; ticker: string; easternDate: string; kalshiOrderId: string | null; requestedContracts: number;
    limitPriceCents: number; side: Eth420Side; step?: number; stateBeforeJson?: string; originalPrimaryKalshiOrderId?: string | null; secondaryClientOrderId?: string | null;
  },
  result: Eth420Side,
): Promise<boolean> {
  if (!["yes", "no"].includes(result)) {
    await recordCandidateRecoveryOutcome(store, order, "official_result_missing");
    return false;
  }
  try {
    const identity = order.secondaryClientOrderId
      ? await recoverCandidateOrderIdentity({ ...order, kalshiOrderId: null })
      : await recoverCandidateOrderIdentity(order);
    if (identity.kind === "proven_absent") {
      // Only the candidate's explicitly unknown POST state is releasable. A
      // reserved row is never deleted by a history scan.
      await store.releaseEth420CandidateProvenAbsentSubmission(order.id);
      await recordCandidateRecoveryOutcome(store, order, "exchange_order_not_found");
      return false;
    }
    if (identity.kind === "ambiguous_retry") {
      await recordCandidateRecoveryOutcome(store, order, "exchange_evidence_ambiguous");
      return false;
    }
    if (identity.kind === "resting_bound") {
      if (order.secondaryClientOrderId && order.kalshiOrderId
        && !await store.replaceEth420CandidatePrimaryWithSecondary(order.id, order.kalshiOrderId, identity.orderId)) {
        await recordCandidateRecoveryOutcome(store, order, "exchange_evidence_ambiguous");
        return false;
      }
      // Persist the exact GTC identity but intentionally retain its
      // reservation: it must be revisited after it becomes terminal.
      if (!order.kalshiOrderId) {
        if (!await store.acknowledgeEth420CandidateLiveOrder(order.id, identity.orderId, "resting_recovered")) {
          await recordCandidateRecoveryOutcome(store, order, "unexpected_error", "acknowledgement_failed");
          return false;
        }
      }
      await recordCandidateRecoveryOutcome(store, order, "not_terminal");
      return false;
    }
    const { orderId, filled } = identity;
    if (order.secondaryClientOrderId && order.kalshiOrderId
      && !await store.replaceEth420CandidatePrimaryWithSecondary(order.id, order.kalshiOrderId, orderId)) {
      await recordCandidateRecoveryOutcome(store, order, "exchange_evidence_ambiguous");
      return false;
    }
    // A lost POST response must first be durably bound to the exact exchange
    // order recovered by client_order_id before any settlement can occur.
    if (!order.kalshiOrderId
      && !await store.acknowledgeEth420CandidateLiveOrder(order.id, orderId, "terminal_recovered")) {
      await recordCandidateRecoveryOutcome(store, order, "unexpected_error", "acknowledgement_failed");
      return false;
    }
    const economics = filled === 0 ? null : await candidateFillEconomics(order, orderId, filled);
    if (filled === 0 ? !await verifyCandidateZeroFill(order, orderId) : !economics) {
      await recordCandidateRecoveryOutcome(store, order, filled === 0 ? "authenticated_fill_missing" : "economics_incomplete");
      return false;
    }
    const persistedState = await store.readPersistedEth420CandidateState(order.easternDate);
    if (!persistedState.available) {
      await recordCandidateRecoveryOutcome(store, order, "persisted_state_read_failed");
      return false;
    }
    const currentState = persistedState.state;
    const recordedState = recordedCandidateStateBefore(order);
    // The original live candidate executor persisted the order's immutable
    // pre-entry snapshot but did not initialize daily state. During recovery,
    // that snapshot is the only truthful bootstrap source. It also anchors an
    // out-of-sequence historical order to the side/step it really placed,
    // rather than inventing a different counterfactual wager.
    const transitionState = recordedState ?? currentState;
    if (!transitionState) {
      await recordCandidateRecoveryOutcome(store, order, "bootstrap_not_allowed");
      return false;
    }
    const spentCents = economics == null ? 0 : Math.round((Number(economics.notional) + Number(economics.fee)) * 100);
    if (!Number.isFinite(spentCents)) {
      await recordCandidateRecoveryOutcome(store, order, "economics_incomplete");
      return false;
    }
    const pnl = filled === 0 ? 0 : (result === order.side ? filled * 100 : 0) - spentCents;
    const nextState = {
      ...advanceEth420State(transitionState, result, filled),
      // Sequence derives from the actual persisted order snapshot; P&L stays
      // cumulative across the chronological recovery sweep.
      realizedPnlCents: (currentState?.realizedPnlCents ?? transitionState.realizedPnlCents) + pnl,
    };
    const settled = await store.settleEth420CandidateLiveOrder({
      id: order.id, result, filledContracts: filled, realizedPnlDeltaCents: pnl, nextState,
      expectedState: currentState,
      actualNotionalDollars: economics?.notional ?? null, actualFeeDollars: economics?.fee ?? null,
      fillPriceCents: economics?.fillPriceCents ?? null,
    });
    await recordCandidateRecoveryOutcome(store, order, settled ? "settled" : "stale_state_retry");
    return settled;
  } catch {
    await recordCandidateRecoveryOutcome(store, order, "unexpected_error", "recovery_exception");
    return false;
  }
}

/** Reconciles every recoverable candidate order for a confirmed market outcome. */
export async function recoverAndSettleEth420CandidateLiveOrders(
  store: Eth420CandidateLiveStore, ticker: string, result: Eth420Side,
): Promise<number> {
  const pending = await store.listPendingEth420CandidateLiveOrders();
  let settled = 0;
  // The persisted id begins with ticker and no caller-provided substring is
  // interpolated into SQL; this filter simply scopes the recovery pass.
  for (const order of pending.filter((entry) => entry.id === `${ticker}:eth420-live-v1`)) {
    if (await recoverAndSettleEth420CandidateLiveOrder(store, order, result)) settled++;
  }
  return settled;
}

let candidateSettlementSweepInFlight: Promise<number> | null = null;

/**
 * Candidate-only lifecycle sweep. It resolves an official outcome before
 * delegating the exchange-identity, fill-economics, and atomic state update to
 * the existing recovery path. This function never evaluates or submits orders.
 */
export function reconcileEth420CandidateLiveSettlements(
  store: Eth420CandidateLiveStore,
): Promise<number> {
  if (candidateSettlementSweepInFlight) return candidateSettlementSweepInFlight;
  candidateSettlementSweepInFlight = (async () => {
    let settled = 0;
    const pending = await store.listPendingEth420CandidateLiveOrders();
    for (const order of pending) {
      if (!["submitted", "submission_unknown_recovery_required", "terminal_recovered", "resting_recovered", "secondary_submission_pending"].includes(order.status)) continue;
      try {
        const official = await candidateOfficialOutcome(order.ticker);
        if (official.kind === "missing") {
          await recordCandidateRecoveryOutcome(store, order, "official_result_missing");
          continue;
        }
        if (official.kind === "not_terminal") {
          await recordCandidateRecoveryOutcome(store, order, "not_terminal");
          continue;
        }
        if (official.kind === "terminal") {
          // Alert telemetry is strictly best-effort: storage trouble here must
          // never defer the established fail-closed recovery attempt.
          try { await store.markEth420CandidateOrderFinalized?.(order.id, Date.now()); } catch { /* no-op */ }
          if (await recoverAndSettleEth420CandidateLiveOrder(store, order, official.result)) settled++;
        }
      } catch {
        // Retain the row for the next scheduled reconciliation attempt. This
        // path is deliberately read-only and must never re-enter submission.
        await recordCandidateRecoveryOutcome(store, order, "unexpected_error", "market_lookup_failed");
      }
    }
    return settled;
  })().finally(() => {
    candidateSettlementSweepInFlight = null;
  });
  return candidateSettlementSweepInFlight;
}

/** Read-only candidate diagnostics for the boundary scheduler. These
 * hypothetical transitions never enter candidate state or execution code. */
export async function getEth420CandidatePriorOrderHints(
  store: Pick<Eth420CandidateLiveStore, "listPendingEth420CandidateLiveOrders">,
): Promise<Array<{
  ticker: string; persistedSide: Eth420Side; persistedStep: number;
  winNextSide: Eth420Side; winNextStep: number;
  lossNextSide: Eth420Side; lossNextStep: number; createdAtMs: number;
}>> {
  const orders = await store.listPendingEth420CandidateLiveOrders();
  return orders.map((order) => {
    const win = advanceEth420CandidateSequence({ side: order.side, step: order.step }, order.side);
    const loss = advanceEth420CandidateSequence(
      { side: order.side, step: order.step }, order.side === "yes" ? "no" : "yes",
    );
    return {
      ticker: order.ticker, persistedSide: order.side, persistedStep: order.step,
      winNextSide: win.side, winNextStep: win.step,
      lossNextSide: loss.side, lossNextStep: loss.step,
      createdAtMs: order.createdAtMs,
    };
  });
}

export interface Eth420CandidateLiveMarket {
  ticker: string; exchangeIndex: number | null; openTime: string | null; closeTime: string | null; status: string | null;
  yesBid: number | null; noBid: number | null;
}

/** Candidate live orders have one deliberately invariant economic shape. */
export function eth420CandidateLiveOrderTerms(effectiveWagerCents: number): {
  limitPriceCents: typeof ETH_420_LIVE_LIMIT_PRICE_CENTS; contracts: number;
} {
  return {
    limitPriceCents: ETH_420_LIVE_LIMIT_PRICE_CENTS,
    contracts: Math.floor(Math.max(0, Math.trunc(effectiveWagerCents)) / ETH_420_LIVE_LIMIT_PRICE_CENTS),
  };
}

function scheduleEth420SecondaryEntry(store: Eth420CandidateLiveStore, order: {
  id: string; ticker: string; easternDate: string; side: Eth420Side; requestedContracts: number;
  limitPriceCents: number; kalshiOrderId: string; createdAtMs: number; secondaryActivationSequence?: number;
}, exchangeIndex: number): void {
  if (!isEth420SecondaryEntryPermitted()) return;
  void captureOrderbook(order.ticker, order.side, order.limitPriceCents).then((snapshot) => {
    const reservationAskCents = snapshot.error ? null : snapshot.lowestLevelCents;
    const timer = setTimeout(() => {
      void tryEth420SecondaryEntry({
        store: {
          getEth420SecondaryActivationCutover: () => store.getEth420SecondaryActivationCutover(),
          claimEth420SecondaryEntryAttempt: (params) => store.claimEth420CandidateSecondaryEntryAttempt(params),
          recordEth420SecondaryEntryEvent: (params) => store.recordEth420CandidateSecondaryEntryEvent(params),
          markEth420CandidateSecondarySubmissionPending: (id, primaryOrderId, clientOrderId) =>
            store.markEth420CandidateSecondarySubmissionPending(id, primaryOrderId, clientOrderId),
        }, primary: order, reservationAskCents, nowMs: Date.now(),
        getCurrentTimeMs: Date.now,
        readPrimary: async () => {
          const raw = await candidateAuthFetch<Record<string, unknown>>("GET", `/portfolio/orders/${encodeURIComponent(order.kalshiOrderId)}`);
          const wire = (raw["order"] as Record<string, unknown> | undefined) ?? raw;
          const parsed = parseKalshiOrderResponse(raw, order.requestedContracts);
          return {
            orderId: parsed.kalshiOrderId ?? "", clientOrderId: typeof wire["client_order_id"] === "string" ? wire["client_order_id"] : "",
            ticker: typeof wire["ticker"] === "string" ? wire["ticker"] : "", status: parsed.orderStatus,
            filledContracts: parsed.fillCountProvided && Number.isFinite(parsed.fillCount) && parsed.fillCount >= 0
              ? parsed.fillCount : null,
          };
        },
        readSelectedSideAsk: async () => {
          const book = await captureOrderbook(order.ticker, order.side, ETH420_SECONDARY_ENTRY_MAX_ASK_CENTS);
          return book.error ? null : book.lowestLevelCents;
        },
        cancelPrimary: async () => {
          const raw = await candidateAuthFetch<Record<string, unknown>>("DELETE", `/portfolio/events/orders/${encodeURIComponent(order.kalshiOrderId)}`);
          const wire = (raw["order"] as Record<string, unknown> | undefined) ?? raw;
          const parsed = parseKalshiOrderResponse(raw, order.requestedContracts);
          return {
            orderId: parsed.kalshiOrderId ?? "", clientOrderId: typeof wire["client_order_id"] === "string" ? wire["client_order_id"] : "",
            ticker: typeof wire["ticker"] === "string" ? wire["ticker"] : "", status: parsed.orderStatus,
            filledContracts: parsed.fillCountProvided && Number.isFinite(parsed.fillCount) && parsed.fillCount >= 0
              ? parsed.fillCount : null,
          };
        },
        submitSecondary: async (request) => {
          const raw = await candidateAuthFetch<Record<string, unknown>>("POST", "/portfolio/events/orders", {
            ticker: request.ticker, client_order_id: request.clientOrderId, side: request.side === "yes" ? "bid" : "ask",
            count: `${request.contracts}.00`, price: (request.priceCents / 100).toFixed(4),
            time_in_force: "good_till_canceled", self_trade_prevention_type: "taker_at_cross", exchange_index: exchangeIndex,
          });
          const wire = (raw["order"] as Record<string, unknown> | undefined) ?? raw;
          const parsed = parseKalshiOrderResponse(raw, request.contracts);
          if (!parsed.kalshiOrderId || wire["client_order_id"] !== request.clientOrderId || wire["ticker"] !== request.ticker) return { orderId: null };
          return { orderId: await store.replaceEth420CandidatePrimaryWithSecondary(order.id, order.kalshiOrderId, parsed.kalshiOrderId)
            ? parsed.kalshiOrderId : null };
        },
      });
    }, Math.max(0, order.createdAtMs + 10_000 - Date.now()));
    timer.unref();
  }).catch(() => { /* missing reservation quote is a fail-closed no-op */ });
}

/** Explicitly opted-in standalone 50¢ GTC executor. It neither imports nor invokes legacy ETH code. */
export async function evaluateAndSubmitEth420CandidateWhenExplicitlyEnabled(
  store: Eth420CandidateLiveStore,
  market: Eth420CandidateLiveMarket,
  candidateMarket: Eth420CandidateMarket,
  onLifecycleEvent?: (stage: "reservation" | "exchange_submission" | "executor_blocked", reason: string) => void,
): Promise<boolean> {
  const note = (stage: "reservation" | "exchange_submission" | "executor_blocked", reason: string) => {
    try { onLifecycleEvent?.(stage, reason); } catch { /* diagnostics cannot change execution */ }
  };
  if (!isEth420CandidateExecutionPermitted()) {
    note("executor_blocked", "execution_not_permitted");
    return false;
  }
  if (!/^KXETH15M-/.test(market.ticker) || market.status?.toLowerCase() !== "open"
    || market.exchangeIndex == null || !Number.isInteger(market.exchangeIndex)) {
    note("executor_blocked", "market_metadata_unusable");
    return false;
  }
  const openTimeMs = candidateMarket.openTimeMs;
  let backFlip = Number.isInteger(openTimeMs) && store.getEth420CandidateBackFlipArm
    ? await store.getEth420CandidateBackFlipArm(openTimeMs!) : null;
  if (backFlip) {
    // The arm exists only after A's durable, authoritative zero-fill
    // settlement. This capture is consequently the single first fresh B
    // measurement after settlement: never wait for or consult a B+1 sample.
    const book = await candidateOrderbookCapture(market.ticker, backFlip.missedSide, ETH_420_LIVE_LIMIT_PRICE_CENTS);
    const identityMatches = book.ticker === market.ticker && candidateMarket.ticker === market.ticker
      && candidateMarket.openTimeMs === backFlip.targetOpenTimeMs && book.capturedAtMs >= backFlip.armedAtMs;
    const rawBook = {
      orderbook_fp: { yes_dollars: book.rawYesDollars, no_dollars: book.rawNoDollars },
    };
    const bids = book.error || !identityMatches ? [] : parseExitSellBids(rawBook, backFlip.missedSide);
    const bid = bids.at(-1)?.priceCents ?? null;
    const selected = bid == null ? null : selectEth420BackFlipSide(backFlip.missedSide, bid);
    const crossesAsk = selected === backFlip.missedSide;
    const chosenAsk = crossesAsk
      ? parseOrderbookResponse(rawBook, selected).reduce<number | null>(
        (best, level) => best == null || level.priceCents < best ? level.priceCents : best, null,
      )
      : null;
    const crossingContracts = crossesAsk && chosenAsk != null ? eth420BackFlipIocContracts(chosenAsk) : null;
    if (selected == null || bid == null || (crossesAsk && crossingContracts == null)) {
      if (!store.fallbackEth420CandidateBackFlip) {
        note("executor_blocked", "back_flip_fallback_audit_unavailable");
        return false;
      }
      await store.fallbackEth420CandidateBackFlip({
        sourceCandidateOrderId: backFlip.sourceCandidateOrderId, targetTicker: market.ticker, targetOpenTimeMs: openTimeMs!,
        observedAtMs: Date.now(), reason: book.error ? "orderbook_unavailable"
          : !identityMatches ? "target_identity_or_freshness_mismatch"
            : crossesAsk ? "missing_or_malformed_chosen_side_ask" : "missing_or_malformed_missed_side_bid",
      });
      backFlip = null;
    } else {
      // The normal state remains the transition source; Back Flip changes only
      // this one order's side and wager.
      const prepared = await prepareEth420CandidateDecision(store, candidateMarket);
      if (!prepared) { note("executor_blocked", "candidate_decision_unavailable"); return false; }
      const { state, decision } = prepared;
      const effectiveWagerCents = crossesAsk
        ? ETH_420_BACK_FLIP_RETAIN_WAGER_CENTS
        : ETH_420_BACK_FLIP_FLIP_WAGER_CENTS;
      const prospectiveLossAllowed = state.realizedPnlCents - effectiveWagerCents
        - estimateEth420FullLossFeeCents(effectiveWagerCents) >= ETH_420_DAILY_LOSS_LIMIT_CENTS;
      if (!prospectiveLossAllowed) { note("executor_blocked", "prospective_loss_blocked_back_flip"); return false; }
      return submitEth420CandidateOrder(store, market, candidateMarket, state, {
        ...decision, side: selected, effectiveWagerCents, overrideIncreasedWager: true,
        prospectiveLossAllowed, finalReason: "back_flip",
      }, { sourceCandidateOrderId: backFlip.sourceCandidateOrderId, targetTicker: market.ticker,
        targetOpenTimeMs: openTimeMs!, observedAtMs: book.capturedAtMs, missedSideBidCents: bid,
        selectedSide: selected, intendedWagerCents: effectiveWagerCents,
        requestedContracts: crossingContracts ?? eth420CandidateLiveOrderTerms(effectiveWagerCents).contracts,
        executionMode: crossesAsk ? "cross_ioc" : "resting_gtc",
        limitPriceCents: crossesAsk ? chosenAsk! : ETH_420_LIVE_LIMIT_PRICE_CENTS });
    }
  }
  const prepared = await prepareEth420CandidateDecision(store, candidateMarket);
  if (!prepared) {
    note("executor_blocked", "candidate_decision_unavailable");
    return false;
  }
  if (!prepared.decision.prospectiveLossAllowed) {
    note("executor_blocked", prepared.decision.finalReason);
    return false;
  }
  return submitEth420CandidateOrder(store, market, candidateMarket, prepared.state, prepared.decision, null, onLifecycleEvent);
}

async function submitEth420CandidateOrder(
  store: Eth420CandidateLiveStore, market: Eth420CandidateLiveMarket, candidateMarket: Eth420CandidateMarket,
  state: Eth420State, decision: Eth420Decision, backFlip: import("../tradeStore.js").Eth420CandidateBackFlipReservation | null,
  onLifecycleEvent?: (stage: "reservation" | "exchange_submission" | "executor_blocked", reason: string) => void,
): Promise<boolean> {
  const note = (stage: "reservation" | "exchange_submission" | "executor_blocked", reason: string) => {
    try { onLifecycleEvent?.(stage, reason); } catch { /* diagnostics cannot change execution */ }
  };
  if (market.exchangeIndex == null || !Number.isInteger(market.exchangeIndex)) {
    note("executor_blocked", "market_metadata_unusable");
    return false;
  }
  const ordinaryTerms = eth420CandidateLiveOrderTerms(decision.effectiveWagerCents);
  const limitPriceCents = backFlip?.limitPriceCents ?? ordinaryTerms.limitPriceCents;
  const contracts = backFlip?.requestedContracts ?? ordinaryTerms.contracts;
  if (contracts < 1) {
    note("executor_blocked", "zero_contracts");
    return false;
  }
  const orderId = `${market.ticker}:eth420-live-v1`;
  const reservationAtMs = Date.now();
  // This is the last durable gate before any exchange read or POST. It
  // atomically refuses unresolved history, missing-state inconsistency, and a
  // state snapshot that changed after this decision was prepared.
  if (!await store.reserveEth420CandidateLiveOrderIfStateMatches({
    id: orderId, ticker: market.ticker, easternDate: candidateMarket.easternDate, side: decision.side,
    step: decision.underlyingStep, requestedContracts: contracts, limitPriceCents,
    effectiveWagerCents: decision.effectiveWagerCents, stateBeforeJson: JSON.stringify(state), expectedState: state, reservationAtMs,
    marketOpenTimeMs: Number.isInteger(candidateMarket.openTimeMs) ? candidateMarket.openTimeMs : null, backFlip,
  })) {
    note("executor_blocked", "reservation_fence_blocked");
    return false;
  }
  note("reservation", "reserved");
  // Deliberately detached from the exchange path: it is never awaited and its
  // failures cannot modify the durable candidate order or its submission.
  scheduleEth420CandidateExecutionTelemetry(store, {
    id: orderId, ticker: market.ticker, easternDate: candidateMarket.easternDate, side: decision.side,
    step: decision.underlyingStep, requestedContracts: contracts, limitPriceCents,
    effectiveWagerCents: decision.effectiveWagerCents, stateBeforeJson: JSON.stringify(state),
    kalshiOrderId: null, status: "reserved", filledContracts: null, realizedPnlDeltaCents: null,
    actualNotionalDollars: null, actualFeeDollars: null, fillPriceCents: null, settlementResult: null,
    stateAfterJson: null, createdAtMs: reservationAtMs, updatedAtMs: reservationAtMs,
  }, reservationAtMs);
  try {
    const balance = kalshiBalanceCents((await candidateBalanceRead(market.exchangeIndex)).value);
    if (balance == null || balance < contracts * limitPriceCents) {
      await store.acknowledgeEth420CandidateLiveOrder(
        orderId, null, "rejected_insufficient_balance", "insufficient_balance_preflight",
      );
      note("executor_blocked", "insufficient_balance");
      return false;
    }
    note("exchange_submission", "post_started");
    const raw = await candidateAuthFetch<Record<string, unknown>>("POST", "/portfolio/events/orders", {
      ticker: market.ticker, client_order_id: orderId,
      // Kalshi V2 represents buy-YES as bid and buy-NO as ask. Back Flip may
      // either cross the first chosen-side ask IOC or rest at its 50¢ GTC limit.
      side: decision.side === "yes" ? "bid" : "ask",
      count: `${contracts}.00`, price: (limitPriceCents / 100).toFixed(4),
      time_in_force: backFlip?.executionMode === "cross_ioc" ? "immediate_or_cancel" : "good_till_canceled",
      self_trade_prevention_type: "taker_at_cross",
      exchange_index: market.exchangeIndex,
    });
    const ack = parseKalshiOrderResponse(raw, contracts);
    // A response without the immutable exchange id is still an ambiguous POST,
    // not a successful acknowledgement. Keep it on the history-recovery path.
    const acknowledged = await store.acknowledgeEth420CandidateLiveOrder(
      orderId, ack.kalshiOrderId, ack.kalshiOrderId ? "submitted" : "submission_unknown_recovery_required",
    );
    if (!acknowledged) {
      note("exchange_submission", "acknowledgement_persist_failed");
      return false;
    }
    note("exchange_submission", ack.kalshiOrderId ? "acknowledged" : "acknowledgement_unknown");
    // Acknowledgement is not settlement evidence. The durable GTC is reconciled
    // from authenticated exchange status/fill evidence before the candidate
    // state can transition.
    if (ack.kalshiOrderId) {
      // The reservation transaction stamps createdAtMs under the shared
      // cutover lock. Re-read it rather than using the pre-transaction wall
      // clock so the timer and forward-only eligibility use one immutable
      // boundary value.
      const persisted = await store.getEth420CandidateLiveOrder(orderId);
      if (persisted?.kalshiOrderId !== ack.kalshiOrderId || !Number.isInteger(persisted?.createdAtMs)) return true;
      scheduleEth420SecondaryEntry(store, {
        id: orderId, ticker: market.ticker, easternDate: candidateMarket.easternDate, side: decision.side,
        requestedContracts: contracts, limitPriceCents, kalshiOrderId: ack.kalshiOrderId, createdAtMs: persisted.createdAtMs,
        secondaryActivationSequence: persisted.secondaryActivationSequence,
      }, market.exchangeIndex);
    }
    return true;
  } catch (err) {
    const rejectionReason = confirmedEth420InsufficientBalanceRejectionReason(err);
    if (rejectionReason) {
      await store.acknowledgeEth420CandidateLiveOrder(
        orderId, null, "rejected_insufficient_balance", rejectionReason,
      );
      note("executor_blocked", "insufficient_balance_rejected");
      return false;
    }
    await store.acknowledgeEth420CandidateLiveOrder(orderId, null, "submission_unknown_recovery_required");
    note("exchange_submission", "post_unknown");
    return false;
  }
}

export function eth420PrincipalForStep(step: number): number {
  return ETH_420_PRINCIPALS_CENTS[Math.max(0, Math.min(5, Math.trunc(step)))]!;
}
/** Same 50¢ Kalshi fee estimate used for candidate prospective-loss gating. */
export function estimateEth420FullLossFeeCents(wagerCents: number): number {
  const contracts = Math.floor(Math.max(0, wagerCents) / 50);
  return Math.ceil(0.07 * contracts * 50 * 50 / 100);
}
export function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * p;
  const low = Math.floor(index), high = Math.ceil(index);
  return low === high ? sorted[low]! : sorted[low]! + (sorted[high]! - sorted[low]!) * (index - low);
}
export function isTrueEth15MinuteAdjacency(currentOpenMs: number | null, priorOpenMs: number | null): boolean {
  return Number.isFinite(currentOpenMs) && Number.isFinite(priorOpenMs)
    && Number.isInteger(currentOpenMs) && Number.isInteger(priorOpenMs)
    && currentOpenMs! % (15 * 60_000) === 0 && priorOpenMs! % (15 * 60_000) === 0
    && currentOpenMs! - priorOpenMs! === 15 * 60_000;
}
export function calculateEth420Move(current: number | null, prior: Eth420StrikeObservation | null, currentOpenMs: number | null): number | null {
  if (!Number.isFinite(current) || current! <= 0 || !prior || !Number.isFinite(prior.floorStrike) || prior.floorStrike! <= 0
    || !isTrueEth15MinuteAdjacency(currentOpenMs, prior.openTimeMs)) return null;
  return Math.abs(current! - prior.floorStrike!) / prior.floorStrike!;
}

type Eth420TelemetryPayload = {
  schemaVersion: 2;
  openTimeMs: number | null;
  priorFloorStrike: number | null;
  priorOpenTimeMs: number | null;
  currentMove: number | null;
  validAdjacentMove: boolean;
};

function parseEth420TelemetryPayload(payloadJson: string): Eth420TelemetryPayload | null {
  try {
    const parsed = JSON.parse(payloadJson) as Partial<Eth420TelemetryPayload>;
    if (parsed.schemaVersion !== 2 || typeof parsed.validAdjacentMove !== "boolean"
      || !("openTimeMs" in parsed) || !("priorFloorStrike" in parsed) || !("priorOpenTimeMs" in parsed)
      || !("currentMove" in parsed)) return null;
    return parsed as Eth420TelemetryPayload;
  } catch {
    return null;
  }
}

function validatedEth420Move(row: { floorStrike: number | null; payloadJson: string }): number | null {
  const payload = parseEth420TelemetryPayload(row.payloadJson);
  if (!payload?.validAdjacentMove || !Number.isFinite(row.floorStrike) || row.floorStrike! <= 0
    || !Number.isFinite(payload.priorFloorStrike) || payload.priorFloorStrike! <= 0
    || !isTrueEth15MinuteAdjacency(payload.openTimeMs, payload.priorOpenTimeMs)
    || !Number.isFinite(payload.currentMove) || payload.currentMove! < 0) return null;
  const calculated = Math.abs(row.floorStrike! - payload.priorFloorStrike!) / payload.priorFloorStrike!;
  return Math.abs(calculated - payload.currentMove!) < 1e-12 ? payload.currentMove! : null;
}

function validatedLiveEth420Fact(row: {
  ticker: string; floorStrike: number | null; payloadJson: string;
}): Eth420HistoryFact | null {
  const openTimeMs = parseEth420TelemetryPayload(row.payloadJson)?.openTimeMs;
  return /^KXETH15M-/.test(row.ticker) && Number.isFinite(row.floorStrike) && row.floorStrike! > 0
    && Number.isInteger(openTimeMs) && openTimeMs! % (15 * 60_000) === 0
    ? { ticker: row.ticker, openTimeMs: openTimeMs!, floorStrike: row.floorStrike!, source: "live" }
    : null;
}

/** Merges facts, not precomputed moves, so a live row can replace historical
 * evidence before any pair is counted. Conflicting facts are removed entirely. */
export function mergeEth420HistoryFacts(
  bootstrapFacts: KalshiEth15mHistoricalFact[],
  liveRows: Array<{ ticker: string; floorStrike: number | null; payloadJson: string }>,
): Eth420HistoryFact[] {
  const facts = new Map<string, Eth420HistoryFact>();
  const conflicts = new Set<string>();
  const add = (fact: Eth420HistoryFact) => {
    const key = `${fact.ticker}:${fact.openTimeMs}`;
    const previous = facts.get(key);
    if (conflicts.has(key)) return;
    if (!previous) { facts.set(key, fact); return; }
    if (previous.floorStrike !== fact.floorStrike) {
      facts.delete(key); conflicts.add(key); return;
    }
    if (fact.source === "live") facts.set(key, fact);
  };
  for (const fact of bootstrapFacts) add({ ...fact, source: "bootstrap" });
  for (const row of liveRows) {
    const fact = validatedLiveEth420Fact(row);
    if (fact) add(fact);
  }
  const byOpen = new Map<number, Eth420HistoryFact[]>();
  for (const fact of facts.values()) byOpen.set(fact.openTimeMs, [...(byOpen.get(fact.openTimeMs) ?? []), fact]);
  return [...byOpen.values()]
    .filter((sameOpen) => sameOpen.length === 1)
    .map(([fact]) => fact!)
    .sort((a, b) => a.openTimeMs - b.openTimeMs);
}

export function eth420MovesFromFacts(facts: Eth420HistoryFact[]): Eth420HistoricalMove[] {
  const byOpen = new Map(facts.map((fact) => [fact.openTimeMs, fact]));
  return facts.flatMap((fact) => {
    const prior = byOpen.get(fact.openTimeMs - 15 * 60_000);
    const move = calculateEth420Move(fact.floorStrike,
      prior ? { ...prior, easternDate: "", observedAtMs: prior.openTimeMs } : null, fact.openTimeMs);
    return move == null ? [] : [{ move, currentOpenTimeMs: fact.openTimeMs, source: fact.source }];
  });
}

function factsForEth420RollingWindow(facts: Eth420HistoryFact[], currentOpenMs: number | null): Eth420HistoryFact[] {
  if (!Number.isInteger(currentOpenMs)) return [];
  // Retain one immediately preceding window so the first in-range market can
  // form a genuine adjacent pair; moves themselves remain inside 28 days.
  const firstRequiredFact = currentOpenMs! - ETH_420_HISTORY_DAYS * 86_400_000 - 15 * 60_000;
  return facts.filter((fact) => fact.openTimeMs >= firstRequiredFact && fact.openTimeMs < currentOpenMs!);
}

function latestEth420PriorObservation(rows: Array<{
  ticker: string; easternDate: string; observedAtMs: number; floorStrike: number | null; payloadJson: string;
}>, currentOpenMs: number | null): Eth420StrikeObservation | null {
  return rows
    .map((row) => ({ ...row, openTimeMs: parseEth420TelemetryPayload(row.payloadJson)?.openTimeMs ?? null }))
    .filter((row) => row.openTimeMs != null && row.openTimeMs < (currentOpenMs ?? -Infinity))
    .sort((a, b) => b.openTimeMs! - a.openTimeMs!)[0] ?? null;
}

function hasAuthoritativeEth420Observation(market: Eth420CandidateMarket): boolean {
  return Number.isFinite(market.floorStrike) && market.floorStrike! > 0
    && Number.isFinite(market.openTimeMs) && Number.isInteger(market.openTimeMs)
    && market.openTimeMs! % (15 * 60_000) === 0;
}

async function buildEth420TelemetryPayload(
  store: Pick<Eth420CandidateTelemetryStore, "listEth420CandidateTelemetry">,
  market: Eth420CandidateMarket,
): Promise<Eth420TelemetryPayload> {
  const history = await store.listEth420CandidateTelemetry(market.observedAtMs - ETH_420_HISTORY_DAYS * 86_400_000);
  const facts = factsForEth420RollingWindow(mergeEth420HistoryFacts(eth420BootstrapFacts, history), market.openTimeMs);
  const priorFact = facts.filter((fact) => fact.openTimeMs < (market.openTimeMs ?? -Infinity)).at(-1) ?? null;
  const prior = priorFact && {
    ticker: priorFact.ticker, easternDate: market.easternDate, observedAtMs: priorFact.openTimeMs,
    floorStrike: priorFact.floorStrike, openTimeMs: priorFact.openTimeMs,
  };
  const currentMove = calculateEth420Move(market.floorStrike, prior, market.openTimeMs);
  return {
    schemaVersion: 2, openTimeMs: market.openTimeMs,
    priorFloorStrike: currentMove == null ? null : prior?.floorStrike ?? null,
    priorOpenTimeMs: currentMove == null ? null : prior?.openTimeMs ?? null,
    currentMove, validAdjacentMove: currentMove != null,
  };
}

/**
 * State-independent statistical evidence shared by isolated ETH services.
 * This reads only the rolling strike telemetry/bootstrap facts; it never reads,
 * advances, resets, or settles Service A martingale state.
 */
export async function prepareEth420StatisticalEvidence(
  store: Pick<Eth420CandidateTelemetryStore, "listEth420CandidateTelemetry">,
  market: Eth420CandidateMarket,
): Promise<{
  currentMove: number | null;
  p95: number | null;
  p99: number | null;
  validObservationCount: number;
} | null> {
  if (!/^KXETH15M-/.test(market.ticker)
    || !Number.isInteger(market.openTimeMs)
    || market.openTimeMs! % (15 * 60_000) !== 0) return null;
  const history = await store.listEth420CandidateTelemetry(
    market.observedAtMs - ETH_420_HISTORY_DAYS * 86_400_000,
  );
  const facts = factsForEth420RollingWindow(
    mergeEth420HistoryFacts(eth420BootstrapFacts, history),
    market.openTimeMs,
  );
  const priorFact = facts.filter((fact) => fact.openTimeMs < market.openTimeMs!).at(-1) ?? null;
  const prior = priorFact && {
    ticker: priorFact.ticker,
    easternDate: market.easternDate,
    observedAtMs: priorFact.openTimeMs,
    floorStrike: priorFact.floorStrike,
    openTimeMs: priorFact.openTimeMs,
  };
  const moves = eth420MovesFromFacts(facts)
    .filter((entry) => entry.currentOpenTimeMs >= market.openTimeMs! - ETH_420_HISTORY_DAYS * 86_400_000)
    .map((entry) => entry.move)
    .filter((move): move is number => Number.isFinite(move) && move >= 0)
    .sort((a, b) => a - b);
  const currentMove = calculateEth420Move(market.floorStrike, prior, market.openTimeMs);
  return {
    currentMove,
    p95: moves.length >= ETH_420_MIN_HISTORY ? percentile(moves, .95) : null,
    p99: moves.length >= ETH_420_MIN_HISTORY ? percentile(moves, .99) : null,
    validObservationCount: moves.length,
  };
}

/**
 * The single state/history evidence path shared by passive observation and a
 * future explicitly enabled executor. It performs no persistence or execution.
 */
export async function prepareEth420CandidateDecision(
  store: Eth420CandidateEvaluationStore,
  market: Eth420CandidateMarket,
): Promise<{ state: Eth420State; decision: Eth420Decision } | null> {
  // Cold-start shadow observation has no prior state row to restore. Use the
  // documented first-run state so the observer can record its first real
  // production market; this preparation path intentionally remains read-only.
  const candidateState = await store.getEth420CandidateState(market.easternDate) ?? {
    easternDate: market.easternDate,
    side: "no" as const,
    step: 0,
    realizedPnlCents: 0,
    lastBlockResetAtMs: null,
  };
  const history = await store.listEth420CandidateTelemetry(market.observedAtMs - ETH_420_HISTORY_DAYS * 86_400_000);
  // The passive collector can append this same window while the executor is
  // preparing its decision. Percentiles must remain strictly prior-window
  // evidence, never include the candidate's current move.
  const facts = factsForEth420RollingWindow(mergeEth420HistoryFacts(eth420BootstrapFacts, history), market.openTimeMs);
  const priorFact = facts.filter((fact) => fact.openTimeMs < (market.openTimeMs ?? -Infinity)).at(-1) ?? null;
  const prior = priorFact && {
    ticker: priorFact.ticker, easternDate: market.easternDate, observedAtMs: priorFact.openTimeMs,
    floorStrike: priorFact.floorStrike, openTimeMs: priorFact.openTimeMs,
  };
  const historicalMoves = eth420MovesFromFacts(facts)
    .filter((entry) => entry.currentOpenTimeMs >= (market.openTimeMs ?? Infinity) - ETH_420_HISTORY_DAYS * 86_400_000);
  const bootstrapObservationCount = historicalMoves.filter((entry) => entry.source === "bootstrap").length;
  const liveTelemetryObservationCount = historicalMoves.filter((entry) => entry.source === "live").length;
  const moves = historicalMoves.map((entry) => entry.move);
  const decision = evaluateEth420Candidate({
    ...market, priorMarket: prior, trailingMoves: moves, state: candidateState,
    estimatedFeeCents: estimateEth420FullLossFeeCents(eth420PrincipalForStep(candidateState.step)),
    bootstrapObservationCount, liveTelemetryObservationCount,
  });
  logger.info({
    ticker: market.ticker, validHistoricalMoves: decision.validObservationCount, p95: decision.p95, p99: decision.p99,
    currentAdjacentMove: decision.currentMove, resultingBand: decision.resultingBand,
    overrideFired: decision.overrideIncreasedWager, bootstrapObservationCount, liveTelemetryObservationCount,
  }, "ETH 420 candidate evaluation");
  return {
    state: candidateState,
    decision,
  };
}

/** Evaluates only; callers may persist the returned data but must never submit an order from this module. */
export function evaluateEth420Candidate(input: Eth420EvaluationInput): Eth420Decision {
  const step = Math.max(0, Math.min(5, Math.trunc(input.state.step)));
  const normalWagerCents = eth420PrincipalForStep(step);
  // Filter before sorting/percentiles: NaN is contagious in common percentile implementations.
  const pool = input.trailingMoves.filter((move): move is number => typeof move === "number" && Number.isFinite(move) && move >= 0).sort((a, b) => a - b);
  const currentMove = calculateEth420Move(input.floorStrike, input.priorMarket, input.openTimeMs);
  const p95 = pool.length >= ETH_420_MIN_HISTORY ? percentile(pool, .95) : null;
  const p99 = pool.length >= ETH_420_MIN_HISTORY ? percentile(pool, .99) : null;
  const atOrAboveP95 = currentMove != null && p95 != null ? currentMove >= p95 : null;
  const belowP99 = currentMove != null && p99 != null ? currentMove < p99 : null;
  const withinStatisticalJumpBand = atOrAboveP95 === true && belowP99 === true;
  // Service A observes the p95-to-p99 band for telemetry only. Service B owns
  // the standalone $420 jump order; A must never change its ladder wager here.
  const sweetSpotTell = withinStatisticalJumpBand;
  const resultingBand = p95 == null || p99 == null || currentMove == null ? "unavailable"
    : withinStatisticalJumpBand ? "p95_to_p99" : atOrAboveP95 ? "at_or_above_p99" : "below_p95";
  const effectiveWagerCents = normalWagerCents;
  const prospectiveWorstCasePnlCents = input.state.realizedPnlCents - effectiveWagerCents - Math.max(0, Math.trunc(input.estimatedFeeCents));
  const prospectiveLossAllowed = prospectiveWorstCasePnlCents >= ETH_420_DAILY_LOSS_LIMIT_CENTS;
  const blockResetApplied = !prospectiveLossAllowed;
  const nextState = blockResetApplied
    ? { ...input.state, step: 0, lastBlockResetAtMs: input.observedAtMs }
    : input.state;
  const signalReason = pool.length < ETH_420_MIN_HISTORY ? "insufficient_history_no_jump"
    : currentMove == null ? "invalid_or_non_adjacent_floor_strike_no_jump"
      : sweetSpotTell ? "jump_signal_observed_service_b_owned" : atOrAboveP95 ? "top_1_percent_excluded" : "normal_ladder";
  return {
    label: ETH_420_CANDIDATE_LABEL, ticker: input.ticker, side: input.state.side, underlyingStep: step,
    normalWagerCents, effectiveWagerCents, validObservationCount: pool.length, p95, p99, currentMove,
    atOrAboveP95, belowP99, sweetSpotTell, overrideIncreasedWager: effectiveWagerCents > normalWagerCents,
    resultingBand,
    bootstrapObservationCount: Math.max(0, Math.trunc(input.bootstrapObservationCount ?? 0)),
    liveTelemetryObservationCount: Math.max(0, Math.trunc(input.liveTelemetryObservationCount ?? 0)),
    prospectiveWorstCasePnlCents, realizedPnlCents: input.state.realizedPnlCents, prospectiveLossAllowed, blockResetApplied,
    finalReason: prospectiveLossAllowed ? signalReason : "prospective_loss_blocked_step_reset_applied",
    nextState,
  };
}

export function advanceEth420State(state: Eth420State, result: "yes" | "no", filledContracts: number): Eth420State {
  if (!Number.isFinite(filledContracts) || filledContracts < 0) return state;
  return { ...state, ...advanceEth420CandidateSequence(state, result) };
}

/**
 * The only durable candidate ladder transition seam. Future lifecycle code
 * must call this only after it has independently verified a terminal exchange
 * outcome and exact fill economics. The store event id makes recovery retries
 * idempotent; verified zero fills advance the sequence but leave P&L unchanged.
 */
export async function applyEth420ConfirmedSettlement(
  store: Pick<Eth420CandidateTelemetryStore, "getEth420CandidateState" | "applyEth420CandidateConfirmedSettlement">,
  settlement: {
    id: string; easternDate: string; result: "yes" | "no"; filledContracts: number; realizedPnlDeltaCents: number;
  },
): Promise<boolean> {
  if (!settlement.id || !Number.isFinite(settlement.filledContracts)
    || !Number.isFinite(settlement.realizedPnlDeltaCents)) return false;
  const current = await store.getEth420CandidateState(settlement.easternDate);
  if (!current) return false;
  const nextState = {
    ...advanceEth420State(current, settlement.result, settlement.filledContracts),
    realizedPnlCents: current.realizedPnlCents + (settlement.filledContracts > 0
      ? Math.trunc(settlement.realizedPnlDeltaCents)
      : 0),
  };
  return store.applyEth420CandidateConfirmedSettlement({
    id: settlement.id, easternDate: settlement.easternDate, nextState,
    realizedPnlDeltaCents: settlement.realizedPnlDeltaCents,
  });
}

/** Passive capture never reaches candidate state, orders, balances, or Kalshi. */
export async function observeEth420Candidate(store: Eth420CandidateTelemetryStore, market: Eth420CandidateMarket): Promise<void> {
  const liveEnabled = process.env["ETH_420_CANDIDATE_LIVE_ENABLED"] === "true";
  const shadowEnabled = process.env["ETH_420_CANDIDATE_SHADOW_ENABLED"] === "true";
  if ((!liveEnabled && !shadowEnabled) || !/^KXETH15M-/.test(market.ticker)) return;
  // WebSocket deltas can precede the REST snapshot that supplies floorStrike.
  // This table permits one immutable row per ticker, so wait for authoritative
  // current-market evidence rather than poisoning that row with an incomplete
  // observation. Once current evidence exists, retain invalid adjacency as a
  // real observation with validAdjacentMove=false.
  if (!hasAuthoritativeEth420Observation(market)) return;
  let telemetry: Eth420TelemetryPayload;
  try {
    telemetry = await buildEth420TelemetryPayload(store, market);
  } catch (err) {
    logger.warn({ err, ticker: market.ticker }, "ETH 420 candidate telemetry preparation failed");
    return;
  }
  if (liveEnabled) {
    try {
      await store.recordEth420CandidateTelemetry({
        id: `${market.ticker}:eth420-candidate`, ticker: market.ticker, easternDate: market.easternDate,
        observedAtMs: market.observedAtMs, floorStrike: market.floorStrike, payloadJson: JSON.stringify(telemetry),
      });
    } catch (err) {
      logger.warn({ err, ticker: market.ticker }, "ETH 420 candidate telemetry write failed");
    }
    return;
  }
  let prepared = await prepareEth420CandidateDecision(store, market);
  if (!prepared) return;
  let { state: candidateState, decision } = prepared;
  if (decision.blockResetApplied && !await store.saveEth420CandidateState(decision.nextState)) return;
  // This is a hypothetical entry only. It does not reserve funds, claim a
  // ticker, inspect an order book, or invoke the live candidate bridge.
  if (decision.prospectiveLossAllowed && Number.isFinite(market.openTimeMs)) {
    const recorded = await store.recordEth420CounterfactualEntry({
      id: `${market.ticker}:eth420-counterfactual-v1`,
      ticker: market.ticker, easternDate: market.easternDate, observedAtMs: market.observedAtMs,
      side: decision.side, step: decision.underlyingStep, effectiveWagerCents: decision.effectiveWagerCents,
      decisionPayloadJson: JSON.stringify({ ...decision, execution: "COUNTERFACTUAL_NO_ORDER_NO_FILL_ASSUMPTION" }),
      stateBeforeJson: JSON.stringify(candidateState),
    });
    if (!recorded) {
      // A settlement may have completed after the initial state read. Reload
      // and re-evaluate once; record() revalidates this snapshot under its
      // shared settlement lock, so stale values can never enter the ledger.
      prepared = await prepareEth420CandidateDecision(store, market);
      if (!prepared || JSON.stringify(prepared.state) === JSON.stringify(candidateState)) return;
      candidateState = prepared.state;
      decision = prepared.decision;
      if (!decision.prospectiveLossAllowed || decision.blockResetApplied) return;
      if (!await store.recordEth420CounterfactualEntry({
        id: `${market.ticker}:eth420-counterfactual-v1`, ticker: market.ticker,
        easternDate: market.easternDate, observedAtMs: market.observedAtMs,
        side: decision.side, step: decision.underlyingStep, effectiveWagerCents: decision.effectiveWagerCents,
        decisionPayloadJson: JSON.stringify({ ...decision, execution: "COUNTERFACTUAL_NO_ORDER_NO_FILL_ASSUMPTION" }),
        stateBeforeJson: JSON.stringify(candidateState),
      })) return;
    }
  }
  await store.recordEth420CandidateTelemetry({
    id: `${market.ticker}:eth420-candidate`, ticker: market.ticker, easternDate: market.easternDate,
    observedAtMs: market.observedAtMs, floorStrike: market.floorStrike,
    payloadJson: JSON.stringify(telemetry),
  });
}