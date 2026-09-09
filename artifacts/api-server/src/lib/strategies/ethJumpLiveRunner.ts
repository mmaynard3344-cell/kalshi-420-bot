import { logger } from "../logger.js";
import type { Eth420CandidateMarket } from "./eth420SixStepCandidate.js";
import { prepareEthJumpServiceIntent } from "./ethJumpServiceRuntime.js";
import { createEthBigBetKalshiSubmitter } from "./ethBigBetKalshiExchange.js";
import { submitEthBigBetIntent } from "./ethBigBetExecutor.js";
import { ethBigBetExecutionStore } from "./ethBigBetExecutionStoreAdapter.js";
import { initEthBigBetStore } from "./ethBigBetStore.js";
import { ethBigBetCapitalRiskCents } from "./ethBigBetLifecycle.js";
import { evaluateEthAccountCapital } from "./ethAccountCapitalGuard.js";
import { readApprovedEthBigBetCapitalBase } from "./ethBigBetApprovedCapitalProvider.js";
import { currentEthServiceEnablement } from "./ethServiceEnablementContract.js";
import { currentEthServiceRole, serviceOwnsJump } from "./ethServiceRole.js";

/**
 * Service B code-side approval. Runtime execution still requires the exact
 * jump role, the matching live environment flag, and a valid enablement
 * contract. Environment misconfiguration therefore remains fail-closed.
 */
export const ETH_JUMP_SERVICE_EXECUTION_APPROVED = true;

export function isEthJumpServiceExecutionPermitted(role = currentEthServiceRole()): boolean {
  const enablement = currentEthServiceEnablement();
  return ETH_JUMP_SERVICE_EXECUTION_APPROVED
    && enablement.valid
    && enablement.mode === "jump_live_requested"
    && serviceOwnsJump(role)
    && process.env["ETH_JUMP_SERVICE_LIVE_ENABLED"] === "true";
}

type JumpEvidenceStore = Parameters<typeof prepareEthJumpServiceIntent>[0]["store"];
type EthJumpLiveOutcome =
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

export async function runEthJumpServiceWhenExplicitlyEnabled(input: {
  store: JumpEvidenceStore;
  market: Eth420CandidateMarket;
  exchangeIndex: number | null | undefined;
}): Promise<EthJumpLiveOutcome> {
  let currentMove: number | null = null;
  let p95: number | null = null;
  let p99: number | null = null;
  let signalRejectionReason: string | null = null;

  const finish = <T extends EthJumpLiveOutcome>(outcome: T, rejectionReason: string | null = null): T => {
    logger.info({
      ticker: input.market.ticker,
      currentMove,
      p95,
      p99,
      outcome,
      rejectionReason: rejectionReason ?? signalRejectionReason,
    }, "ETH Jump evaluation");
    return outcome;
  };

  if (!isEthJumpServiceExecutionPermitted()) return finish("disabled", "execution_not_permitted");

  const intent = await prepareEthJumpServiceIntent({
    store: input.store,
    market: input.market,
    onEvaluation: (observation) => {
      currentMove = observation.currentMove;
      p95 = observation.p95;
      p99 = observation.p99;
      signalRejectionReason = observation.rejectionReason;
    },
  });
  if (!intent) return finish("no_signal");

  if (input.exchangeIndex == null || !Number.isInteger(input.exchangeIndex) || input.exchangeIndex < 0) {
    return finish("routing_unavailable", "invalid_exchange_index");
  }

  // Capital facts query eth_big_bet_orders, so the dedicated B/C ledger must
  // exist before the fail-closed capital provider attempts that read.
  try {
    await ensureStoreReady();
  } catch {
    return finish("storage_unavailable", "execution_store_unavailable");
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

  const outcome = await submitEthBigBetIntent({
    intent,
    store: ethBigBetExecutionStore,
    exchange,
    capital: capitalBase,
    requestedRiskCents,
  });

  const rejectionReason = outcome === "submitted"
    ? null
    : outcome === "blocked_duplicate"
      ? "duplicate_strategy_market"
      : outcome === "blocked_invalid_size"
        ? "invalid_order_size"
        : outcome === "capital_blocked"
          ? "capital_guard_blocked"
          : outcome === "reservation_failed"
            ? "durable_reservation_failed"
            : outcome === "submission_unknown"
              ? "exchange_submission_unknown"
              : outcome === "rejected"
                ? "exchange_rejected_reason_not_exposed_by_executor"
                : outcome;

  return finish(outcome, rejectionReason);
}
