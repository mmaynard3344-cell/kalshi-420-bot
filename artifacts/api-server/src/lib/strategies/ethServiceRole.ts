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
import { getEthMartingaleBlockerStatus } from "./ethOnlyMartingale.js";

export const ETH_SERVICE_ROLES = ["martingale", "jump", "reversal"] as const;
export type EthServiceRole = typeof ETH_SERVICE_ROLES[number];

export function parseEthServiceRole(raw: string | undefined): EthServiceRole | null {
  return raw != null && (ETH_SERVICE_ROLES as readonly string[]).includes(raw)
    ? raw as EthServiceRole
    : null;
}

export function currentEthServiceRole(): EthServiceRole | null {
  const role = parseEthServiceRole(process.env["ETH_SERVICE_ROLE"]);
  if (role === "martingale") {
    const blocker = getEthMartingaleBlockerStatus();
    console.info("ETH Service A blocker diagnostic", {
      code: blocker.code,
      message: blocker.message,
      retryScheduled: blocker.retryScheduled,
      retryAttempt: blocker.retryAttempt,
      ticker: blocker.ticker,
      orderId: blocker.orderId,
      outcome: blocker.outcome,
      filledContracts: blocker.filledContracts,
      requestedContracts: blocker.requestedContracts,
      exchangeIndex: blocker.exchangeIndex,
      availableBalanceCents: blocker.availableBalanceCents,
      requiredBalanceCents: blocker.requiredBalanceCents,
      balanceStale: blocker.balanceStale,
    });
  }
  return role;
}

export function serviceOwnsMartingale(role: EthServiceRole | null): boolean {
  return role === "martingale";
}

/**
 * Backward-compatible, fail-closed runtime gate for Service A.
 *
 * Production historically ran with ETH_SERVICE_ROLE truly unset, so undefined
 * preserves that behavior. Once a role variable is explicitly supplied, only
 * the exact value "martingale" may run A. A blank or mistyped value therefore
 * suppresses A rather than accidentally reverting to the legacy default.
 */
export function serviceMayRunMartingale(
  role: EthServiceRole | null,
  rawRole: string | undefined = process.env["ETH_SERVICE_ROLE"],
): boolean {
  if (rawRole == null) return true;
  return role === "martingale";
}

export function serviceOwnsJump(role: EthServiceRole | null): boolean {
  return role === "jump";
}

export function serviceOwnsReversal(role: EthServiceRole | null): boolean {
  return role === "reversal";
}
