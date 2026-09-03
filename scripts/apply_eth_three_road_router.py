from pathlib import Path

candidate_path = Path("artifacts/api-server/src/lib/strategies/eth420SixStepCandidate.ts")
candidate = candidate_path.read_text()
old = '''  if (!prepared.decision.prospectiveLossAllowed) {
    note("executor_blocked", prepared.decision.finalReason);
    return false;
  }
  return submitEth420CandidateOrder(store, market, candidateMarket, prepared.state, prepared.decision, null, onLifecycleEvent);
}'''
new = '''  // Ordinary ladder windows belong exclusively to the regular ETH martingale.
  // ETH420 may execute only a confirmed Back Flip (handled above) or a
  // qualifying p95-to-p99 Jump. This prevents the candidate from duplicating
  // the ordinary martingale on every window.
  if (!prepared.decision.sweetSpotTell) {
    note("executor_blocked", "ordinary_martingale_owned");
    return false;
  }
  if (!prepared.decision.prospectiveLossAllowed) {
    note("executor_blocked", prepared.decision.finalReason);
    return false;
  }
  return submitEth420CandidateOrder(store, market, candidateMarket, prepared.state, prepared.decision, null, onLifecycleEvent);
}'''
if "ordinary_martingale_owned" not in candidate:
    if candidate.count(old) != 1:
        raise SystemExit(f"candidate replacement count={candidate.count(old)}")
    candidate = candidate.replace(old, new)
    candidate_path.write_text(candidate)

auto_path = Path("artifacts/api-server/src/lib/autoTrader.ts")
auto = auto_path.read_text()
old_import = '''import {
  evaluateAndSubmitEth420CandidateWhenExplicitlyEnabled,
  isEth420CandidateExecutionPermitted,
  observeEth420Candidate,
} from "./strategies/eth420SixStepCandidate.js";'''
new_import = '''import {
  evaluateAndSubmitEth420CandidateWhenExplicitlyEnabled,
  isEth420CandidateExecutionPermitted,
  observeEth420Candidate,
  prepareEth420CandidateDecision,
  type Eth420CandidateMarket,
} from "./strategies/eth420SixStepCandidate.js";'''
if "prepareEth420CandidateDecision," not in auto.split('from "./strategies/eth420SixStepCandidate.js";')[0][-500:]:
    if auto.count(old_import) != 1:
        raise SystemExit(f"import replacement count={auto.count(old_import)}")
    auto = auto.replace(old_import, new_import)

marker = '''/** Per-ticker timestamp of the last pre-window status log (throttle). */
const lastPreWindowLogMs = new Map<string, number>();'''
router = '''/** Exactly one ETH execution road may evaluate a ticker at a time. */
const ethWindowRouteInFlight = new Set<string>();

type EthWindowExecutionRoad = "regular" | "jump" | "back_flip" | "hold" | "owned";

function eth420CandidateMarketFromState(state: MarketState): Eth420CandidateMarket {
  const parsedOpenTimeMs = state.openTime == null ? NaN : Date.parse(state.openTime);
  const openTimeMs = Number.isFinite(parsedOpenTimeMs) ? parsedOpenTimeMs : null;
  return {
    ticker: state.ticker,
    easternDate: openTimeMs == null ? easternDay(new Date()) : easternDay(new Date(openTimeMs)),
    observedAtMs: Date.now(),
    floorStrike: state.floorStrike ?? null,
    openTimeMs,
  };
}

/**
 * One-window execution router.
 * Priority: durable current owner -> unresolved prior candidate hold ->
 * Back Flip -> qualifying p95-p99 Jump -> ordinary martingale.
 */
async function selectEthWindowExecutionRoad(
  state: MarketState,
  candidateMarket: Eth420CandidateMarket,
): Promise<EthWindowExecutionRoad> {
  if (!isEth420CandidateExecutionPermitted()) return "regular";

  try {
    const candidatePending = await tradeStore.listPendingEth420CandidateLiveOrders();

    // Restart-safe candidate ownership fence.
    if (candidatePending.some((order) => order.ticker === state.ticker)) return "owned";

    const openTimeMs = candidateMarket.openTimeMs;
    if (openTimeMs == null) return "hold";

    // B must not fall through to regular while immediately preceding A is
    // unresolved; A may still prove to be a zero fill and arm a Back Flip.
    const unresolvedPriorCandidate = candidatePending.some((order) =>
      order.ticker !== state.ticker
      && order.createdAtMs < openTimeMs
      && openTimeMs - order.createdAtMs <= 20 * 60_000
    );
    if (unresolvedPriorCandidate) return "hold";

    const backFlip = await tradeStore.getEth420CandidateBackFlipArm(openTimeMs);
    if (backFlip) return "back_flip";

    const prepared = await prepareEth420CandidateDecision(tradeStore, candidateMarket);
    if (!prepared) return "hold";
    return prepared.decision.sweetSpotTell ? "jump" : "regular";
  } catch (err) {
    logger.warn({ err, ticker: state.ticker }, "ETH window router failed closed");
    return "hold";
  }
}

async function executeEth420SpecialRoad(
  state: MarketState,
  candidateMarket: Eth420CandidateMarket,
  timing: EvalTiming,
): Promise<void> {
  // A regular martingale position—whether from this process or a restart—is
  // a durable owner. Never layer a Jump/Back Flip on top of it.
  const regularExposure = await hasUnsettledEthMartingaleExposure();
  if (regularExposure !== false) {
    logger.info(
      { ticker: state.ticker, regularExposure },
      "ETH special road blocked by unresolved regular martingale exposure",
    );
    return;
  }

  await evaluateAndSubmitEth420CandidateWhenExplicitlyEnabled(
    tradeStore,
    {
      ticker: state.ticker,
      exchangeIndex: state.exchangeIndex ?? null,
      openTime: state.openTime,
      closeTime: state.closeTime,
      status: state.status,
      yesBid: state.yesBid,
      noBid: state.noBid,
    },
    candidateMarket,
    timing.boundaryOpenTimeMs == null ? undefined : (stage, reason) => {
      recordBoundaryDiscoveryAudit({
        ticker: state.ticker,
        openTimeMs: timing.boundaryOpenTimeMs!,
        atMs: Date.now(),
        stage,
        reason,
      });
    },
  );
}

'''
if "type EthWindowExecutionRoad" not in auto:
    if auto.count(marker) != 1:
        raise SystemExit(f"router insertion marker count={auto.count(marker)}")
    auto = auto.replace(marker, router + marker)

old_eval = '''  // New ETH martingale positions are deliberately not routed through the
  // legacy 80¢ protective-exit path. Legacy cleanup runs only from the
  // restored-position monitor in index.ts and is never driven by this evaluator.
  if (isEthTicker(state.ticker)) {
    await (_evaluateEthNoMartingaleImpl ?? evaluateEthNoMartingale)({
      ticker: state.ticker,
      exchangeIndex: state.exchangeIndex ?? null,
      openTime: state.openTime,
      closeTime: state.closeTime,
      status: state.status,
    });
    await evaluateEth420Candidate(state, _timing);
  }'''
new_eval = '''  // ETH routes each ticker down exactly one mutually-exclusive road:
  // confirmed Back Flip, qualifying p95-p99 $420 Jump, or ordinary martingale.
  if (isEthTicker(state.ticker)) {
    if (ethWindowRouteInFlight.has(state.ticker)) return;
    ethWindowRouteInFlight.add(state.ticker);
    try {
      const candidateMarket = eth420CandidateMarketFromState(state);
      observeEth420Candidate(tradeStore, candidateMarket)
        .catch((err) => logger.warn({ err, ticker: state.ticker }, "ETH 420 candidate observation failed"));

      const road = await selectEthWindowExecutionRoad(state, candidateMarket);
      logger.info({ ticker: state.ticker, road }, "ETH window execution road selected");

      if (road === "hold" || road === "owned") return;
      if (road === "back_flip" || road === "jump") {
        await executeEth420SpecialRoad(state, candidateMarket, _timing);
        return;
      }

      await (_evaluateEthNoMartingaleImpl ?? evaluateEthNoMartingale)({
        ticker: state.ticker,
        exchangeIndex: state.exchangeIndex ?? null,
        openTime: state.openTime,
        closeTime: state.closeTime,
        status: state.status,
      });
      return;
    } finally {
      ethWindowRouteInFlight.delete(state.ticker);
    }
  }'''
if "ETH window execution road selected" not in auto:
    if auto.count(old_eval) != 1:
        raise SystemExit(f"evaluate replacement count={auto.count(old_eval)}")
    auto = auto.replace(old_eval, new_eval)

old_candidate_helper = '''async function evaluateEth420Candidate(state: MarketState, timing: EvalTiming): Promise<void> {
  const candidateOpenTimeMs = state.openTime == null ? null : Date.parse(state.openTime);
  const candidateMarket = {
    ticker: state.ticker,
    easternDate: candidateOpenTimeMs != null && Number.isFinite(candidateOpenTimeMs)
      ? easternDay(new Date(candidateOpenTimeMs)) : easternDay(new Date()),
    observedAtMs: Date.now(), floorStrike: state.floorStrike ?? null, openTimeMs: candidateOpenTimeMs,
  };
  observeEth420Candidate(tradeStore, candidateMarket)
    .catch((err) => logger.warn({ err, ticker: state.ticker }, "ETH 420 candidate observation failed"));
  if (isEth420CandidateExecutionPermitted() || timing.boundaryOpenTimeMs != null) {
    await evaluateAndSubmitEth420CandidateWhenExplicitlyEnabled(
      tradeStore,
      {
        ticker: state.ticker, exchangeIndex: state.exchangeIndex ?? null, openTime: state.openTime,
        closeTime: state.closeTime, status: state.status, yesBid: state.yesBid, noBid: state.noBid,
      },
      candidateMarket,
      timing.boundaryOpenTimeMs == null ? undefined : (stage, reason) => {
        recordBoundaryDiscoveryAudit({
          ticker: state.ticker, openTimeMs: timing.boundaryOpenTimeMs!, atMs: Date.now(), stage, reason,
        });
      },
    );
  }
}'''
new_candidate_helper = '''async function evaluateEth420Candidate(state: MarketState, timing: EvalTiming): Promise<void> {
  const candidateMarket = eth420CandidateMarketFromState(state);
  observeEth420Candidate(tradeStore, candidateMarket)
    .catch((err) => logger.warn({ err, ticker: state.ticker }, "ETH 420 candidate observation failed"));
  const road = await selectEthWindowExecutionRoad(state, candidateMarket);
  if (road === "back_flip" || road === "jump") {
    await executeEth420SpecialRoad(state, candidateMarket, timing);
  }
}'''
if "const road = await selectEthWindowExecutionRoad(state, candidateMarket);\n  if (road === \"back_flip\" || road === \"jump\")" not in auto:
    if auto.count(old_candidate_helper) != 1:
        raise SystemExit(f"candidate helper replacement count={auto.count(old_candidate_helper)}")
    auto = auto.replace(old_candidate_helper, new_candidate_helper)

auto_path.write_text(auto)
