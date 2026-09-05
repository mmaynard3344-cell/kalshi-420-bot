from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label} replacement count={count}")
    return text.replace(old, new)

# 1) Regular becomes the one authoritative six-step martingale.
regular_path = ROOT / "artifacts/api-server/src/lib/strategies/ethOnlyMartingale.ts"
regular = regular_path.read_text()
regular = replace_once(
    regular,
    "export const ETH_PRINCIPALS_CENTS = [1500, 3000, 6000] as const;",
    "export const ETH_PRINCIPALS_CENTS = [1500, 3000, 6000, 12000, 24000, 32000] as const;",
    "regular principals",
)
regular = replace_once(
    regular,
    "export const ETH_DAILY_LOSS_STOP_CENTS = -25_000;",
    "export const ETH_DAILY_LOSS_STOP_CENTS = -120_000;",
    "regular daily stop",
)
regular = replace_once(
    regular,
    "return ETH_PRINCIPALS_CENTS[Math.max(0, Math.min(2, step))]!;",
    "return ETH_PRINCIPALS_CENTS[Math.max(0, Math.min(5, step))]!;",
    "regular step clamp",
)
regular = replace_once(
    regular,
    "lossNextStep: row.martingaleStep >= 2 ? 0 : row.martingaleStep + 1,",
    "lossNextStep: row.martingaleStep >= 5 ? 0 : row.martingaleStep + 1,",
    "regular hint transition",
)
old_wrapper = '''export async function evaluateEthNoMartingale(state: EthMarketState): Promise<void> {
  await runEthPreflightAndPlacement({ state });
}'''
new_wrapper = '''export async function evaluateEthNoMartingale(state: EthMarketState): Promise<void> {
  await runEthPreflightAndPlacement({ state });
}

/** Original p95-p99 Jump: only the wager is overridden. Side, step, settlement,
 * and every durable transition remain owned by the same Regular six-step state. */
export async function evaluateEthMartingaleWithPrincipal(
  state: EthMarketState,
  requestedPrincipalCents: number,
): Promise<void> {
  await runEthPreflightAndPlacement({ state, requestedPrincipalCents });
}'''
regular = replace_once(regular, old_wrapper, new_wrapper, "jump regular gateway")
regular_path.write_text(regular)

# 2) Durable Regular settlement is six-step. A zero fill is no martingale result.
store_path = ROOT / "artifacts/api-server/src/lib/tradeStore.ts"
store = store_path.read_text()
if store.count('const nextStep = won ? 0 : orderStep >= 2 ? 0 : orderStep + 1;') != 2:
    raise SystemExit("unexpected Regular nextStep seam count")
store = store.replace(
    'const nextStep = won ? 0 : orderStep >= 2 ? 0 : orderStep + 1;',
    'const nextStep = won ? 0 : orderStep >= 5 ? 0 : orderStep + 1;',
)
zero_start = store.index('      const orderSide: "yes" | "no" = row.side === "yes" ? "yes" : "no";', store.index('export async function advanceEthMartingaleLadderForZeroFill'))
zero_end_marker = '      return true;\n    });'
zero_end = store.index(zero_end_marker, zero_start) + len('      return true;')
zero_replacement = '''      // A zero fill is not a martingale result. It neither wins nor loses,
      // never changes side/step, and never arms a Back Flip. The order row above
      // remains the durable audit that the market was attempted with zero fills.
      return true;'''
store = store[:zero_start] + zero_replacement + store[zero_end:]
store_path.write_text(store)

# 3) Candidate executor becomes signal-only: no Back Flip and no candidate order.
candidate_path = ROOT / "artifacts/api-server/src/lib/strategies/eth420SixStepCandidate.ts"
candidate = candidate_path.read_text()
fn_start = candidate.index('export async function evaluateAndSubmitEth420CandidateWhenExplicitlyEnabled(')
fn_end = candidate.index('\nasync function submitEth420CandidateOrder(', fn_start)
new_signal_fn = '''export async function evaluateAndSubmitEth420CandidateWhenExplicitlyEnabled(
  store: Eth420CandidateLiveStore,
  market: Eth420CandidateLiveMarket,
  candidateMarket: Eth420CandidateMarket,
  onLifecycleEvent?: (stage: "reservation" | "exchange_submission" | "executor_blocked", reason: string) => void,
): Promise<boolean> {
  const note = (stage: "reservation" | "exchange_submission" | "executor_blocked", reason: string) => {
    try { onLifecycleEvent?.(stage, reason); } catch { /* diagnostics cannot change execution */ }
  };
  if (!/^KXETH15M-/.test(market.ticker) || market.status?.toLowerCase() !== "open"
    || market.exchangeIndex == null || !Number.isInteger(market.exchangeIndex)) {
    note("executor_blocked", "market_metadata_unusable");
    return false;
  }
  // Back Flip is retired. Candidate logic is now read-only Jump signal detection;
  // the Regular gateway owns every exchange order and every martingale state transition.
  // This signal no longer depends on the retired candidate-execution enable flag.
  const prepared = await prepareEth420CandidateDecision(store, candidateMarket);
  if (!prepared) {
    note("executor_blocked", "candidate_decision_unavailable");
    return false;
  }
  if (prepared.decision.sweetSpotTell) {
    note("executor_blocked", "jump_martingale_owned");
    return false;
  }
  note("executor_blocked", "ordinary_martingale_owned");
  return false;
}'''
candidate = candidate[:fn_start] + new_signal_fn + candidate[fn_end:]
candidate_path.write_text(candidate)

# 4) Two-road router: Regular or Jump, both through the same Regular state/gateway.
auto_path = ROOT / "artifacts/api-server/src/lib/autoTrader.ts"
auto = auto_path.read_text()
auto = replace_once(
    auto,
    '  evaluateEthNoMartingale,\n  reconcileEthMartingaleSettlements,',
    '  evaluateEthNoMartingale,\n  evaluateEthMartingaleWithPrincipal,\n  reconcileEthMartingaleSettlements,',
    "auto regular jump import",
)
old_route = '''  // ETH routes each ticker down exactly one mutually-exclusive road.
  // Candidate evaluation runs first and returns whether the regular martingale
  // owns this window. Any unresolved/special candidate condition fails closed.
  if (isEthTicker(state.ticker)) {
    // Settle/cancel the immediately prior Regular lifecycle before choosing
    // ownership for this window. A verified Regular zero-fill arms the existing
    // one-window Back Flip in that same durable settlement transaction.
    if (!await reconcileEthMartingaleSettlements()) return;
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
new_route = '''  // ETH has exactly two roads, both owned by one durable six-step martingale:
  // ordinary Regular size, or the original p95-p99 $420 Jump size override.
  if (isEthTicker(state.ticker)) {
    if (!await reconcileEthMartingaleSettlements()) return;
    const road = await evaluateEth420Candidate(state, _timing);
    const ethState = {
      ticker: state.ticker,
      exchangeIndex: state.exchangeIndex ?? null,
      openTime: state.openTime,
      closeTime: state.closeTime,
      status: state.status,
    };
    if (road === "jump") {
      await evaluateEthMartingaleWithPrincipal(ethState, 42_000);
    } else if (road === "regular") {
      await (_evaluateEthNoMartingaleImpl ?? evaluateEthNoMartingale)(ethState);
    }
    return;
  }'''
auto = replace_once(auto, old_route, new_route, "two-road evaluate route")
helper_start = auto.index('async function evaluateEth420Candidate(')
helper_end = auto.index('\n/** Candidate-only', helper_start)
new_helper = '''async function evaluateEth420Candidate(
  state: MarketState,
  timing: EvalTiming,
): Promise<"jump" | "regular" | "hold"> {
  const candidateOpenTimeMs = state.openTime == null ? null : Date.parse(state.openTime);
  const candidateMarket = {
    ticker: state.ticker,
    easternDate: candidateOpenTimeMs != null && Number.isFinite(candidateOpenTimeMs)
      ? easternDay(new Date(candidateOpenTimeMs)) : easternDay(new Date()),
    observedAtMs: Date.now(), floorStrike: state.floorStrike ?? null, openTimeMs: candidateOpenTimeMs,
  };
  observeEth420Candidate(tradeStore, candidateMarket)
    .catch((err) => logger.warn({ err, ticker: state.ticker }, "ETH 420 candidate observation failed"));

  let lastReason: string | null = null;
  await evaluateAndSubmitEth420CandidateWhenExplicitlyEnabled(
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
  if (lastReason === "jump_martingale_owned") return "jump";
  if (lastReason === "ordinary_martingale_owned") return "regular";
  return "hold";
}'''
auto = auto[:helper_start] + new_helper + auto[helper_end:]
auto_path.write_text(auto)
