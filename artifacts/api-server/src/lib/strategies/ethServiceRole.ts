/** Explicit runtime ownership boundary for isolated ETH strategy services. */
export const ETH_SERVICE_ROLES = [
  "martingale", "jump", "reversal", "downfade_e", "downfade_f", "downfade_g", "downfade_h",
] as const;
export type EthServiceRole = typeof ETH_SERVICE_ROLES[number];

export function parseEthServiceRole(raw: string | undefined): EthServiceRole | null {
  return raw != null && (ETH_SERVICE_ROLES as readonly string[]).includes(raw)
    ? raw as EthServiceRole : null;
}

export function currentEthServiceRole(): EthServiceRole | null {
  return parseEthServiceRole(process.env["ETH_SERVICE_ROLE"]);
}

export function serviceOwnsMartingale(role: EthServiceRole | null): boolean { return role === "martingale"; }

/** Unset preserves the historical A runtime; any explicit non-A role suppresses A. */
export function serviceMayRunMartingale(
  role: EthServiceRole | null,
  rawRole: string | undefined = process.env["ETH_SERVICE_ROLE"],
): boolean {
  if (rawRole == null) return true;
  return role === "martingale";
}

export function serviceOwnsJump(role: EthServiceRole | null): boolean { return role === "jump"; }
export function serviceOwnsReversal(role: EthServiceRole | null): boolean { return role === "reversal"; }
export function serviceOwnsDownfade(role: EthServiceRole | null): boolean {
  return role === "downfade_e" || role === "downfade_f" || role === "downfade_g" || role === "downfade_h";
}
