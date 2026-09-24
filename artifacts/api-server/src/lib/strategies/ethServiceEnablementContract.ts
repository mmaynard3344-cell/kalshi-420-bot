import { parseEthServiceRole, type EthServiceRole } from "./ethServiceRole.js";

export type EthServiceEnablementMode =
  | "legacy_martingale"
  | "martingale"
  | "jump_staged"
  | "jump_live_requested"
  | "reversal_staged"
  | "reversal_live_requested"
  | "downfade_staged"
  | "downfade_live_requested"
  | "ash_v2_staged"
  | "ash_v2_live_requested";

export interface EthServiceEnablementInput {
  rawRole?: string;
  jumpLiveEnabled?: string;
  reversalLiveEnabled?: string;
  downfadeLiveEnabled?: string;
  ashV2LiveEnabled?: string;
}

export interface EthServiceEnablementResult {
  valid: boolean;
  role: EthServiceRole | null;
  mode: EthServiceEnablementMode | null;
  reason: string | null;
}

function enabled(raw: string | undefined): boolean { return raw === "true"; }
function isDownfadeRole(role: EthServiceRole | null): boolean {
  return role === "downfade_e" || role === "downfade_f" || role === "downfade_g" || role === "downfade_h";
}

export function evaluateEthServiceEnablement(input: EthServiceEnablementInput): EthServiceEnablementResult {
  const role = parseEthServiceRole(input.rawRole);
  const jumpLive = enabled(input.jumpLiveEnabled);
  const reversalLive = enabled(input.reversalLiveEnabled);
  const downfadeLive = enabled(input.downfadeLiveEnabled);
  const ashV2Live = enabled(input.ashV2LiveEnabled);
  const liveCount = Number(jumpLive) + Number(reversalLive) + Number(downfadeLive) + Number(ashV2Live);

  if (input.rawRole != null && role == null) return { valid: false, role: null, mode: null, reason: "invalid_service_role" };
  if (liveCount > 1) return { valid: false, role, mode: null, reason: "multiple_live_services_requested" };

  if (role == null) {
    if (liveCount > 0) return { valid: false, role, mode: null, reason: "live_flag_without_explicit_role" };
    return { valid: true, role, mode: "legacy_martingale", reason: null };
  }
  if (role === "martingale") {
    if (liveCount > 0) return { valid: false, role, mode: null, reason: "big_bet_live_flag_on_martingale_service" };
    return { valid: true, role, mode: "martingale", reason: null };
  }
  if (role === "jump") {
    if (reversalLive || downfadeLive || ashV2Live) return { valid: false, role, mode: null, reason: "wrong_live_flag_on_jump_service" };
    return { valid: true, role, mode: jumpLive ? "jump_live_requested" : "jump_staged", reason: null };
  }
  if (role === "reversal") {
    if (jumpLive || downfadeLive || ashV2Live) return { valid: false, role, mode: null, reason: "wrong_live_flag_on_reversal_service" };
    return { valid: true, role, mode: reversalLive ? "reversal_live_requested" : "reversal_staged", reason: null };
  }
  if (isDownfadeRole(role)) {
    if (jumpLive || reversalLive || ashV2Live) return { valid: false, role, mode: null, reason: "wrong_live_flag_on_downfade_service" };
    return { valid: true, role, mode: downfadeLive ? "downfade_live_requested" : "downfade_staged", reason: null };
  }
  if (role === "ash_v2_i") {
    if (jumpLive || reversalLive || downfadeLive) return { valid: false, role, mode: null, reason: "wrong_live_flag_on_ash_v2_service" };
    return { valid: true, role, mode: ashV2Live ? "ash_v2_live_requested" : "ash_v2_staged", reason: null };
  }
  return { valid: false, role, mode: null, reason: "invalid_service_role" };
}

export function currentEthServiceEnablement(): EthServiceEnablementResult {
  return evaluateEthServiceEnablement({
    rawRole: process.env["ETH_SERVICE_ROLE"],
    jumpLiveEnabled: process.env["ETH_JUMP_SERVICE_LIVE_ENABLED"],
    reversalLiveEnabled: process.env["ETH_REVERSAL_SERVICE_LIVE_ENABLED"],
    downfadeLiveEnabled: process.env["ETH_DOWNFADE_SERVICE_LIVE_ENABLED"],
    ashV2LiveEnabled: process.env["ETH_ASH_V2_SERVICE_LIVE_ENABLED"],
  });
}
