/**
 * Explicit runtime ownership boundary for isolated ETH strategy services.
 *
 * This module is deliberately pure and additive. Until callers opt into it,
 * existing production behavior is unchanged.
 */
export const ETH_SERVICE_ROLES = ["martingale", "jump", "reversal"] as const;
export type EthServiceRole = typeof ETH_SERVICE_ROLES[number];

export function parseEthServiceRole(raw: string | undefined): EthServiceRole | null {
  return raw != null && (ETH_SERVICE_ROLES as readonly string[]).includes(raw)
    ? raw as EthServiceRole
    : null;
}

export function currentEthServiceRole(): EthServiceRole | null {
  return parseEthServiceRole(process.env["ETH_SERVICE_ROLE"]);
}

export function serviceOwnsMartingale(role: EthServiceRole | null): boolean {
  return role === "martingale";
}

export function serviceOwnsJump(role: EthServiceRole | null): boolean {
  return role === "jump";
}

export function serviceOwnsReversal(role: EthServiceRole | null): boolean {
  return role === "reversal";
}
