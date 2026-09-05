from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label} replacement count={count}")
    return text.replace(old, new)

# Preserve the already-deployed <50c Back Flip settlement compatibility first.
# The final section below then retires all new Back Flip execution.
candidate_path = ROOT / "artifacts/api-server/src/lib/strategies/eth420SixStepCandidate.ts"
candidate = candidate_path.read_text()

old = '''    const nextState = {\n      ...advanceEth420State(transitionState, result, filled),\n      // Sequence derives from the actual persisted order snapshot; P&L stays\n      // cumulative across the chronological recovery sweep.\n      realizedPnlCents: (currentState?.realizedPnlCents ?? transitionState.realizedPnlCents) + pnl,\n    };'''
new = '''    // The <50c Back Flip is an isolated $25 opposite-side trade. It owns this\n    // market, but it must not advance, reset, or flip the martingale sequence.\n    // Its immutable live-order signature is 50 requested contracts at the 50c\n    // resting limit. P&L is still accounted normally.\n    const neutralLt50BackFlip = order.requestedContracts === 50\n      && order.limitPriceCents === ETH_420_LIVE_LIMIT_PRICE_CENTS;\n    const sequenceState = neutralLt50BackFlip\n      ? transitionState\n      : advanceEth420State(transitionState, result, filled);\n    const nextState = {\n      ...sequenceState,\n      // Sequence derives from the actual persisted order snapshot; P&L stays\n      // cumulative across the chronological recovery sweep.\n      realizedPnlCents: (currentState?.realizedPnlCents ?? transitionState.realizedPnlCents) + pnl,\n    };'''
candidate = replace_once(candidate, old, new, "lt50 neutral martingale")

# Final production simplification: candidate code remains the p95-p99 signal
# engine only. A qualifying Jump is executed by the existing Regular gateway so
# side, rung, reservation, fill recovery, and settlement all use one durable
# Regular martingale state. Back Flip helpers/tables remain only for historical
# recovery compatibility and are never consulted for new execution.
candidate = replace_once(
    candidate,
    'import { advanceEth420CandidateSequence } from "./eth420CandidateState.js";\n',
    'import { advanceEth420CandidateSequence } from "./eth420CandidateState.js";\nimport { runEthPreflightAndPlacement } from "./ethOnlyMartingale.js";\n',
    "regular gateway import",
)

fn_start = candidate.index('export async function evaluateAndSubmitEth420CandidateWhenExplicitlyEnabled(')
fn_end = candidate.index('\nasync function submitEth420CandidateOrder(', fn_start)
new_signal_executor = '''export async function evaluateAndSubmitEth420CandidateWhenExplicitlyEnabled(
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

  // Old candidate/Back-Flip orders are still recovered conservatively. Never
  // open a Regular or Jump order while a prior candidate lifecycle is unresolved.
  const pending = await store.listPendingEth420CandidateLiveOrders();
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
  if (!prepared.decision.sweetSpotTell) {
    note("executor_blocked", "ordinary_martingale_owned");
    return false;
  }

  // Original Jump: signal changes only this window's principal to $420. The
  // existing Regular gateway reads the authoritative Regular side/rung and
  // persists that rung on the order, so the official settlement advances the
  // same six-step sequence as any ordinary Regular trade.
  note("reservation", "jump_martingale_owned");
  await runEthPreflightAndPlacement({
    state: {
      ticker: market.ticker,
      exchangeIndex: market.exchangeIndex,
      openTime: market.openTime,
      closeTime: market.closeTime,
      status: market.status,
    },
    requestedPrincipalCents: ETH_420_OVERRIDE_CENTS,
  });
  return true;
}'''
candidate = candidate[:fn_start] + new_signal_executor + candidate[fn_end:]
candidate_path.write_text(candidate)

# One authoritative six-step Regular ladder.
regular_path = ROOT / "artifacts/api-server/src/lib/strategies/ethOnlyMartingale.ts"
regular = regular_path.read_text()
regular = replace_once(
    regular,
    ' * Three-step martingale. Principals: $15, $30, $60 (cents: 1500, 3000, 6000).\n'
    ' * Side starts "no" each ET day. After a win: side flips yes↔no, step=0.\n'
    ' * After a loss: side unchanged, step increments; after step 2 it resets to 0.\n'
    ' * Daily state resets when the ET day changes (no timer).\n'
    ' * Fail-closed if current day realized P&L ≤ -$250.00 (-25000 cents).\n',
    ' * Six-step martingale. Principals: $15, $30, $60, $120, $240, $320.\n'
    ' * Side starts "no" each ET day. After a win: side flips yes↔no, step=0.\n'
    ' * After a loss: side unchanged, step increments; after step 5 it resets to 0.\n'
    ' * Daily state resets when the ET day changes (no timer).\n'
    ' * Fail closed if a full-loss projection (principal + fee) would move the\n'
    ' * current ET-day realized P&L below -$1,200.\n',
    "regular strategy header",
)
regular = replace_once(
    regular,
    'export const ETH_PRINCIPALS_CENTS = [1500, 3000, 6000] as const;',
    'export const ETH_PRINCIPALS_CENTS = [1500, 3000, 6000, 12000, 24000, 32000] as const;',
    "regular six principals",
)
regular = replace_once(
    regular,
    'export const ETH_DAILY_LOSS_STOP_CENTS = -25_000;',
    'export const ETH_DAILY_LOSS_STOP_CENTS = -120_000;',
    "regular daily loss stop",
)
regular = replace_once(
    regular,
    'return ETH_PRINCIPALS_CENTS[Math.max(0, Math.min(2, step))]!;',
    'return ETH_PRINCIPALS_CENTS[Math.max(0, Math.min(5, step))]!;',
    "regular step clamp",
)
regular = replace_once(
    regular,
    'lossNextStep: row.martingaleStep >= 2 ? 0 : row.martingaleStep + 1,',
    'lossNextStep: row.martingaleStep >= 5 ? 0 : row.martingaleStep + 1,',
    "regular diagnostic loss transition",
)

risk_old = '''    const reservedFeeCents = ethTakerFeeCents(noPriceCents, contracts);\n    const requiredBalanceCents = contracts * noPriceCents + reservedFeeCents;'''
risk_new = '''    const reservedFeeCents = ethTakerFeeCents(noPriceCents, contracts);\n    const projectedFullLossPnlCents = effectivePnl - requestedPrincipalCents - reservedFeeCents;\n    if (projectedFullLossPnlCents < dailyLossStopCents) {\n      setEthBlockerStatus(\n        "daily_loss_stop",\n        "ETH entry is blocked because a full loss on this wager would exceed the daily loss limit",\n      );\n      return;\n    }\n    const requiredBalanceCents = contracts * noPriceCents + reservedFeeCents;'''
regular = replace_once(regular, risk_old, risk_new, "prospective daily loss gate")
regular_path.write_text(regular)

# Durable filled Regular settlements use all six rungs. A proven zero fill is
# not a win/loss and therefore leaves the Regular side/rung untouched and never
# arms a Back Flip.
store_path = ROOT / "artifacts/api-server/src/lib/tradeStore.ts"
store = store_path.read_text()
zero_fn = store.index('export async function advanceEthMartingaleLadderForZeroFill(')
zero_start = store.index('      const orderSide: "yes" | "no" = row.side === "yes" ? "yes" : "no";', zero_fn)
zero_tail = '''      return true;\n    });\n  } catch (err) {\n    logger.warn({ err, id }, "eth: zero-fill ladder advance failed");'''
zero_end = store.index(zero_tail, zero_start)
store = store[:zero_start] + '''      // A proven zero fill has no market exposure and is not a martingale\n      // result. Preserve the exact Regular side/rung for the next eligible\n      // market. Back Flip is retired, so no successor override is armed.\n''' + store[zero_end:]

old_transition = 'const nextStep = won ? 0 : orderStep >= 2 ? 0 : orderStep + 1;'
if store.count(old_transition) != 1:
    raise SystemExit(f"filled Regular transition count after zero-fill neutralization={store.count(old_transition)}")
store = store.replace(old_transition, 'const nextStep = won ? 0 : orderStep >= 5 ? 0 : orderStep + 1;')
store = store.replace(
    '// Step transition: win → step=0, side flips; loss → step+1, after step 2 → 0',
    '// Step transition: win → step=0, side flips; loss → step+1, after step 5 → 0',
)
store_path.write_text(store)
