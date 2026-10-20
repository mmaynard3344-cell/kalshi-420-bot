/**
 * A durable exit journal's canonical keys. The database must enforce UNIQUE
 * (strategy, entryOrderId, exitClientOrderId) and UNIQUE (providerFillId).
 * Pure validation helps integrations fail closed on identity ambiguity.
 */
export interface Target75FillEvidence {
  strategy: string;
  ticker: string;
  entryOrderId: string;
  exitClientOrderId: string;
  providerOrderId: string;
  providerFillId: string;
  heldSide: "yes" | "no";
  contracts: number;
  grossProceedsCents: number;
  feeCents: number;
}

export function validateTarget75FillEvidence(
  f: Target75FillEvidence,
  expected: { strategy: string; ticker: string; entryOrderId: string; exitClientOrderId: string;
    providerOrderId: string; heldSide: "yes" | "no"; maxOpenContracts: number; seenFillIds: ReadonlySet<string> },
): "ok" | "invalid" | "mismatch" | "duplicate" {
  if (!/^KXETH[A-Z0-9]*-[A-Z0-9-]+$/.test(f.ticker) ||
      [f.strategy, f.entryOrderId, f.exitClientOrderId, f.providerOrderId, f.providerFillId]
        .some(v => typeof v !== "string" || v.length === 0) ||
      ![f.contracts, f.grossProceedsCents, f.feeCents].every(
        n => Number.isSafeInteger(n) && n >= 0,
      ) || f.contracts === 0)
    return "invalid";
  if (f.strategy !== expected.strategy || f.ticker !== expected.ticker ||
      f.entryOrderId !== expected.entryOrderId ||
      f.exitClientOrderId !== expected.exitClientOrderId ||
      f.providerOrderId !== expected.providerOrderId ||
      f.heldSide !== expected.heldSide || f.contracts > expected.maxOpenContracts)
    return "mismatch";
  if (expected.seenFillIds.has(f.providerFillId)) return "duplicate";
  return "ok";
}
