export const BK_FRESH_BALANCE_CAPITAL_POLICY_ENV = "BK_FRESH_BALANCE_CAPITAL_POLICY" as const;

export const BK_CAPITAL_SERVICES = ["B","C","D","E","F","G","H","I","J","K"] as const;
export type BkCapitalService = typeof BK_CAPITAL_SERVICES[number];
export type BkCapitalDecision = "allow" | "block" | "unavailable";

export interface BkCapitalAdmissionInput {
  service: BkCapitalService;
  ticker: string;
  exchangeIndex: number;
  requestedRiskCents: number;
  freshAvailableBalanceCents: number | null;
  oldPolicyDecision: BkCapitalDecision;
  oldPolicyBlocker: string | null;
  flagRaw?: string | undefined;
}

export interface BkCapitalAdmissionDecision {
  service: BkCapitalService;
  ticker: string;
  exchangeIndex: number;
  requestedRiskCents: number;
  freshAvailableBalanceCents: number | null;
  oldPolicyDecision: BkCapitalDecision;
  oldPolicyBlocker: string | null;
  flagEnabled: boolean;
  newPolicyDecision: BkCapitalDecision;
  finalDecision: BkCapitalDecision;
  finalAllowed: boolean;
}

function validNonnegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export function isBkFreshBalanceCapitalPolicyEnabled(
  raw: string | undefined = process.env[BK_FRESH_BALANCE_CAPITAL_POLICY_ENV],
): boolean {
  return raw === "true";
}

export function evaluateBkFreshBalanceOnly(
  freshAvailableBalanceCents: number | null,
  requestedRiskCents: number,
): BkCapitalDecision {
  if (freshAvailableBalanceCents == null
    || !validNonnegativeInteger(freshAvailableBalanceCents)
    || !Number.isSafeInteger(requestedRiskCents)
    || requestedRiskCents < 1) return "unavailable";
  return freshAvailableBalanceCents >= requestedRiskCents ? "allow" : "block";
}

export function evaluateBkCapitalAdmission(input: BkCapitalAdmissionInput): BkCapitalAdmissionDecision {
  const flagEnabled = isBkFreshBalanceCapitalPolicyEnabled(input.flagRaw);
  const newPolicyDecision = evaluateBkFreshBalanceOnly(
    input.freshAvailableBalanceCents,
    input.requestedRiskCents,
  );
  const finalDecision = flagEnabled ? newPolicyDecision : input.oldPolicyDecision;
  return {
    service: input.service,
    ticker: input.ticker,
    exchangeIndex: input.exchangeIndex,
    requestedRiskCents: input.requestedRiskCents,
    freshAvailableBalanceCents: input.freshAvailableBalanceCents,
    oldPolicyDecision: input.oldPolicyDecision,
    oldPolicyBlocker: input.oldPolicyBlocker,
    flagEnabled,
    newPolicyDecision,
    finalDecision,
    finalAllowed: finalDecision === "allow",
  };
}

export function bkCapitalTelemetry(
  decision: BkCapitalAdmissionDecision,
  orderResult: string,
) {
  return {
    service: decision.service,
    ticker: decision.ticker,
    exchange_index: decision.exchangeIndex,
    requested_risk_cents: decision.requestedRiskCents,
    fresh_available_balance_cents: decision.freshAvailableBalanceCents,
    old_policy_decision: decision.oldPolicyDecision,
    bk_flag_enabled: decision.flagEnabled,
    new_policy_decision: decision.newPolicyDecision,
    final_decision: decision.finalDecision,
    order_result: orderResult,
  };
}
