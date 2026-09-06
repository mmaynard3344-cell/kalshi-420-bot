/**
 * Explicit runtime ownership boundary for isolated ETH strategy services.
 *
 * A = martingale: owns ladder state and settlement-driven transitions only.
 * B = jump: owns the p95-p99 $420 big-bet order and reads A's carried side only.
 * C = reversal: owns the 3+ NO / p95-p99 $500 YES big-bet order.
 *
 * Strategy state is never shared. Account-level capital may be coordinated by
 * a separate guard because all services can still draw from the same account.
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

/**
 * Backward-compatible runtime gate for Service A.
 *
 * Production historically ran without ETH_SERVICE_ROLE. Keeping null allowed
 * preserves that behavior until the A deployment is deliberately assigned the
 * martingale role. Explicit B/C roles, however, must never execute either
 * martingale-family evaluator from the shared API process.
 */
export function serviceMayRunMartingale(role: EthServiceRole | null): boolean {
  return role == null || role === "martingale";
}

export function serviceOwnsJump(role: EthServiceRole | null): boolean {
  return role === "jump";
}

export function serviceOwnsReversal(role: EthServiceRole | null): boolean {
  return role === "reversal";
}
