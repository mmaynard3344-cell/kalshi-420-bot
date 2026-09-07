import { logger } from "../logger.js";
import type { Eth420CandidateMarket } from "./eth420SixStepCandidate.js";
import { evaluateEthAccountCapital } from "./ethAccountCapitalGuard.js";
import { createEthBigBetKalshiSubmitter } from "./ethBigBetKalshiExchange.js";
import { submitEthBigBetIntent } from "./ethBigBetExecutor.js";
import { ethBigBetExecutionStore } from "./ethBigBetExecutionStoreAdapter.js";
import { ethBigBetCapitalRiskCents } from "./ethBigBetLifecycle.js";
import { readApprovedEthBigBetCapitalBase } from "./ethBigBetApprovedCapitalProvider.js";
import { initEthBigBetStore } from "./ethBigBetStore.js";
import { prepareEthBreakoutReversalServiceIntent } from "./ethBreakoutReversalRuntime.js";
import { currentEthServiceRole, serviceOwnsReversal } from "./ethServiceRole.js";

/**
 * Service D execution is explicitly approved. Runtime execution still requires
 * the isolated reversal role, the exact Service D live flag, and both Service C
 * and Jump live flags to remain off on this service.
 */
export const ETH_BREAKOUT_REVERSAL_SERVICE_EXECUTION_APPROVED = true;

export function isEthReversalServiceExecutionPermitted(role = currentEthServiceRole()): boolean {
  return ETH_BREAKOUT_REVERSAL_SERVICE_EXECUTION_APPROVED
    && serviceOwnsReversal(role)
    && process.env["ETH_BREAKOUT_REVERSAL_SERVICE_LIVE_ENABLED"] === "true"
    && process.env["ETH_REVERSAL_SERVICE_LIVE_ENABLED"] !== "true"
    && process.env["ETH_JUMP_SERVICE_LIVE_ENABLED"] !== "true";
}

type BreakoutReversalEvidenceStore = Parameters<typeof prepareEthBreakoutReversalServiceIntent>[0]["store"];
type BreakoutReversalOutcome =
  | "disabled"
  | "no_signal"
  | "capital_unavailable"
  | "capital_blocked"
  | "routing_unavailable"
  | "storage_unavailable"
  | "submitted"
  | "blocked_duplicate"
  | "blocked_invalid_size"
  | "reservation_failed"
  | "submission_unknown"
  | "rejected";

let storeReady: Promise<void> | null = null;

async function ensureStoreReady(): Promise<void> {
  storeReady ??= initEthBigBetStore();
  return storeReady;
}

/**
 * The function name is retained because autoTrader already calls this isolated
 * service hook on the Service C branch. On service-d-breakout-reversal the hook
 * is deliberately repurposed to Service D only; Service C remains untouched on
 * its own service-c-100 branch.
 */
export async function runEthReversalServiceWhenExplicitlyEnabled(input: {
  store: BreakoutReversalEvidenceStore;
  market: Eth420CandidateMarket;
  exchangeIndex: number | null | undefined;
}): Promise<BreakoutReversalOutcome> {
  let priorOutcomes: Array<"yes" | "no" | "missing_or_conflict"> = [];
  let consecutiveNoOutcomes: number | null = null;
  let currentMove: number | null = null;
  let p95: number | null = null;
  let p99: number | null = null;
  let upperBandFloor: number | null = null;
  let signalRejectionReason: string | null = null;

  const finish = <T extends BreakoutReversalOutcome>(
    outcome: T,
    rejectionReason: string | null = null,
  ): T => {
    logger.info(
      {
        ticker: input.market.ticker,
        priorOutcomes,
        consecutiveNoOutcomes,
        currentMove,
        p95,
        p99,
        upperBandFloor,
        outcome,
        rejectionReason,
      },
      "ETH Breakout Reversal evaluation",
    );
    return outcome;
  };

  if (!isEthReversalServiceExecutionPermitted()) {
    return finish("disabled", "execution_not_permitted");
  }
  const { getWindowLog } = await import("../windowLog.js");
  const intent = await prepareEthBreakoutReversalServiceIntent({
    store: input.store,
    market: input.market,
    windowEntries: getWindowLog(),
    onEvaluation: (context) => {
      priorOutcomes = context.priorOutcomes;
      consecutiveNoOutcomes = context.consecutiveNoOutcomes;
      currentMove = context.currentMove;
      p95 = context.p95;
      p99 = context.p99;
      upperBandFloor = context.upperBandFloor;
      signalRejectionReason = context.rejectionReason;
    },
  });
  if (!intent) return finish("no_signal", signalRejectionReason ?? "signal_not_qualified");
  if (input.exchangeIndex == null || !Number.isInteger(input.exchangeIndex) || input.exchangeIndex < 0) {
    return finish("routing_unavailable", "invalid_exchange_index");
  }
  const capitalBase = await readApprovedEthBigBetCapitalBase(input.exchangeIndex);
  if (!capitalBase) return finish("capital_unavailable", "capital_base_unavailable");
  const requestedRiskCents = ethBigBetCapitalRiskCents(intent.wagerCents, intent.limitPriceCents);
  if (requestedRiskCents < 1) return finish("capital_unavailable", "invalid_requested_risk");
  const capital = evaluateEthAccountCapital({ ...capitalBase, requestedRiskCents });
  if (!capital.allowed) {
    return finish(
      capital.reason === "invalid_input" ? "capital_unavailable" : "capital_blocked",
      capital.reason,
    );
  }
  const exchange = createEthBigBetKalshiSubmitter(input.exchangeIndex);
  if (!exchange) return finish("routing_unavailable", "exchange_route_unavailable");
  try {
    await ensureStoreReady();
  } catch {
    return finish("storage_unavailable", "execution_store_unavailable");
  }
  const outcome = await submitEthBigBetIntent({
    intent,
    store: ethBigBetExecutionStore,
    exchange,
    capital: capitalBase,
    requestedRiskCents,
  });
  return finish(
    outcome,
    outcome === "submitted" ? null : outcome === "rejected" ? "exchange_rejected_reason_not_exposed_by_executor" : outcome,
  );
}
