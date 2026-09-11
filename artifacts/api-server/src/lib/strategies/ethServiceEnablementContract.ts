import { parseEthServiceRole, type EthServiceRole } from "./ethServiceRole.js";

export type EthServiceEnablementMode =
  | "legacy_martingale"
  | "martingale"
  | "jump_staged"
  | "jump_live_requested"
  | "reversal_staged"
  | "reversal_live_requested";

export interface EthServiceEnablementInput {
  rawRole?: string;
  jumpLiveEnabled?: string;
  reversalLiveEnabled?: string;
}

export interface EthServiceEnablementResult {
  valid: boolean;
  role: EthServiceRole | null;
  mode: EthServiceEnablementMode | null;
  reason: string | null;
}

function enabled(raw: string | undefined): boolean {
  return raw === "true";
}

/**
 * Fail-closed configuration contract for isolated ETH services.
 *
 * This does not approve execution. B/C still require their separate hard-code
 * approval constants. It only proves that role/live environment settings are
 * internally consistent before a future enablement commit is considered.
 */
export function evaluateEthServiceEnablement(
  input: EthServiceEnablementInput,
): EthServiceEnablementResult {
  const role = parseEthServiceRole(input.rawRole);
  const jumpLive = enabled(input.jumpLiveEnabled);
  const reversalLive = enabled(input.reversalLiveEnabled);

  if (input.rawRole != null && role == null) {
    return { valid: false, role: null, mode: null, reason: "invalid_service_role" };
  }
  if (jumpLive && reversalLive) {
    return { valid: false, role, mode: null, reason: "multiple_live_services_requested" };
  }

  if (role == null) {
    if (jumpLive || reversalLive) {
      return { valid: false, role, mode: null, reason: "live_flag_without_explicit_role" };
    }
    return { valid: true, role, mode: "legacy_martingale", reason: null };
  }

  if (role === "martingale") {
    if (jumpLive || reversalLive) {
      return { valid: false, role, mode: null, reason: "big_bet_live_flag_on_martingale_service" };
    }
    return { valid: true, role, mode: "martingale", reason: null };
  }

  if (role === "jump") {
    if (reversalLive) {
      return { valid: false, role, mode: null, reason: "reversal_live_flag_on_jump_service" };
    }
    return {
      valid: true,
      role,
      mode: jumpLive ? "jump_live_requested" : "jump_staged",
      reason: null,
    };
  }

  if (jumpLive) {
    return { valid: false, role, mode: null, reason: "jump_live_flag_on_reversal_service" };
  }
  return {
    valid: true,
    role,
    mode: reversalLive ? "reversal_live_requested" : "reversal_staged",
    reason: null,
  };
}

export function currentEthServiceEnablement(): EthServiceEnablementResult {
  return evaluateEthServiceEnablement({
    rawRole: process.env["ETH_SERVICE_ROLE"],
    jumpLiveEnabled: process.env["ETH_JUMP_SERVICE_LIVE_ENABLED"],
    reversalLiveEnabled: process.env["ETH_REVERSAL_SERVICE_LIVE_ENABLED"],
  });
}
