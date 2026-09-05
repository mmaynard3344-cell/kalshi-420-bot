/**
 * Pure strategy dispatcher for isolated ETH services.
 *
 * The dispatcher performs no exchange I/O and owns no persistence. Its only
 * job is to ensure a runtime role can evaluate exactly one strategy family.
 */
import type { EthServiceRole } from "./ethServiceRole.js";
import { evaluateEthMartingaleSignal, type EthMartingaleState } from "./ethMartingaleSignal.js";
import { evaluateEthJumpSignal, type EthJumpSignalInput } from "./ethJumpSignal.js";
import { evaluateEthNoStreakReversal, type EthNoStreakReversalInput } from "./ethNoStreakReversal.js";

export type EthServiceDispatchResult =
  | { role: "martingale"; decision: ReturnType<typeof evaluateEthMartingaleSignal> }
  | { role: "jump"; decision: ReturnType<typeof evaluateEthJumpSignal> }
  | { role: "reversal"; decision: ReturnType<typeof evaluateEthNoStreakReversal> };

export function dispatchEthServiceSignal(input: {
  role: EthServiceRole;
  martingaleState?: EthMartingaleState;
  jump?: EthJumpSignalInput;
  reversal?: EthNoStreakReversalInput;
}): EthServiceDispatchResult | null {
  if (input.role === "martingale") {
    return input.martingaleState
      ? { role: "martingale", decision: evaluateEthMartingaleSignal(input.martingaleState) }
      : null;
  }
  if (input.role === "jump") {
    return input.jump
      ? { role: "jump", decision: evaluateEthJumpSignal(input.jump) }
      : null;
  }
  return input.reversal
    ? { role: "reversal", decision: evaluateEthNoStreakReversal(input.reversal) }
    : null;
}
