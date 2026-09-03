from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

candidate_path = ROOT / "artifacts/api-server/src/lib/strategies/eth420SixStepCandidate.ts"
candidate = candidate_path.read_text()

old_candidate_tail = '''  const prepared = await prepareEth420CandidateDecision(store, candidateMarket);
  if (!prepared) {
    note("executor_blocked", "candidate_decision_unavailable");
    return false;
  }
  if (!prepared.decision.prospectiveLossAllowed) {
    note("executor_blocked", prepared.decision.finalReason);
    return false;
  }
  return submitEth420CandidateOrder(store, market, candidateMarket, prepared.state, prepared.decision, null, onLifecycleEvent);
}'''
new_candidate_tail = '''  const pending = await store.listPendingEth420CandidateLiveOrders();
  const currentOpenTimeMs = candidateMarket.openTimeMs;
  const unresolvedPriorCandidate = currentOpenTimeMs != null && pending.some((order) =>
    order.ticker !== market.ticker
      && order.createdAtMs < currentOpenTimeMs
      && currentOpenTimeMs - order.createdAtMs <= 20 * 60_000
  );
  if (unresolvedPriorCandidate) {
    note("executor_blocked", "earlier_candidate_unresolved");
    return false;
  }

  const prepared = await prepareEth420CandidateDecision(store, candidateMarket);
  if (!prepared) {
    note("executor_blocked", "candidate_decision_unavailable");
    return false;
  }
  // Ordinary ladder windows are owned exclusively by the regular ETH martingale.
  // ETH420 may execute only a confirmed Back Flip (handled above) or a qualifying
  // p95-to-p99 jump. This prevents duplicate ordinary submissions.
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
if candidate.count(old_candidate_tail) != 1:
    raise SystemExit(f"candidate tail replacement count={candidate.count(old_candidate_tail)}")
candidate_path.write_text(candidate.replace(old_candidate_tail, new_candidate_tail))

auto_path = ROOT / "artifacts/api-server/src/lib/autoTrader.ts"
auto = auto_path.read_text()

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
new_eval = '''  // ETH routes each ticker down exactly one mutually-exclusive road.
  // Candidate evaluation runs first and returns whether the regular martingale
  // owns this window. Any unresolved/special candidate condition fails closed.
  if (isEthTicker(state.ticker)) {
    const candidateRoad = await evaluateEth420Candidate(state, _timing);
    if (candidateRoad === "regular") {
      await (_evaluateEthNoMartingaleImpl ?? evaluateEthNoMartingale)({
        ticker: state.ticker,
        exchangeIndex: state.exchangeIndex ?? null,
        openTime: state.openTime,
        closeTime: state.closeTime,
        status: state.status,
      });
    }
    return;
  }'''
if auto.count(old_eval) != 1:
    raise SystemExit(f"evaluate replacement count={auto.count(old_eval)}")
auto = auto.replace(old_eval, new_eval)

old_helper = '''async function evaluateEth420Candidate(state: MarketState, timing: EvalTiming): Promise<void> {
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
new_helper = '''async function evaluateEth420Candidate(
  state: MarketState,
  timing: EvalTiming,
): Promise<"special" | "regular" | "hold"> {
  const candidateOpenTimeMs = state.openTime == null ? null : Date.parse(state.openTime);
  const candidateMarket = {
    ticker: state.ticker,
    easternDate: candidateOpenTimeMs != null && Number.isFinite(candidateOpenTimeMs)
      ? easternDay(new Date(candidateOpenTimeMs)) : easternDay(new Date()),
    observedAtMs: Date.now(), floorStrike: state.floorStrike ?? null, openTimeMs: candidateOpenTimeMs,
  };
  observeEth420Candidate(tradeStore, candidateMarket)
    .catch((err) => logger.warn({ err, ticker: state.ticker }, "ETH 420 candidate observation failed"));

  if (!isEth420CandidateExecutionPermitted() && timing.boundaryOpenTimeMs == null) return "regular";

  let lastReason: string | null = null;
  const submitted = await evaluateAndSubmitEth420CandidateWhenExplicitlyEnabled(
    tradeStore,
    {
      ticker: state.ticker, exchangeIndex: state.exchangeIndex ?? null, openTime: state.openTime,
      closeTime: state.closeTime, status: state.status, yesBid: state.yesBid, noBid: state.noBid,
    },
    candidateMarket,
    (stage, reason) => {
      lastReason = reason;
      if (timing.boundaryOpenTimeMs != null) {
        recordBoundaryDiscoveryAudit({
          ticker: state.ticker, openTimeMs: timing.boundaryOpenTimeMs, atMs: Date.now(), stage, reason,
        });
      }
    },
  );

  if (submitted) return "special";
  return lastReason === "ordinary_martingale_owned" ? "regular" : "hold";
}'''
if auto.count(old_helper) != 1:
    raise SystemExit(f"candidate helper replacement count={auto.count(old_helper)}")
auto_path.write_text(auto.replace(old_helper, new_helper))
