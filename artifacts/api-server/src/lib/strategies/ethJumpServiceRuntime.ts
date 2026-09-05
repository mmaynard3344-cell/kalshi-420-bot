import { prepareEth420CandidateDecision, type Eth420CandidateMarket } from "./eth420SixStepCandidate.js";
import { buildEthJumpOrderIntent } from "./ethBigBetIntent.js";
import { currentEthServiceRole, serviceOwnsJump } from "./ethServiceRole.js";
import type { EthBigBetOrderIntent } from "./ethBigBetLifecycle.js";

type JumpEvidenceStore = Parameters<typeof prepareEth420CandidateDecision>[0];

/**
 * Service B's read-only signal-preparation seam.
 *
 * It deliberately reuses the existing authoritative rolling-28-day evidence
 * preparation so A and B cannot drift on p95/p99 or adjacency semantics. The
 * only martingale datum B consumes is A's carried side from the persisted state
 * snapshot returned by that preparation path. B never saves, advances, resets,
 * or settles that state.
 *
 * This function performs no exchange submission and no B-order persistence.
 */
export async function prepareEthJumpServiceIntent(input: {
  store: JumpEvidenceStore;
  market: Eth420CandidateMarket;
  role?: ReturnType<typeof currentEthServiceRole>;
}): Promise<EthBigBetOrderIntent | null> {
  const role = input.role === undefined ? currentEthServiceRole() : input.role;
  if (!serviceOwnsJump(role)) return null;
  if (!Number.isInteger(input.market.openTimeMs)) return null;

  const prepared = await prepareEth420CandidateDecision(input.store, input.market);
  if (!prepared) return null;

  return buildEthJumpOrderIntent({
    ticker: input.market.ticker,
    marketOpenTimeMs: input.market.openTimeMs!,
    carriedSide: prepared.state.side,
    currentMove: prepared.decision.currentMove,
    p95: prepared.decision.p95,
    p99: prepared.decision.p99,
  });
}
