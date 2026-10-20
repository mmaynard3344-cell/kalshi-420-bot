/**
 * A verified early exchange exit is not the same event as binary market
 * settlement. Only a provider-authenticated fill may reduce remaining exposure.
 * The existing martingale ladder is intentionally NOT advanced here.
 */
export interface Target75LotAccounting {
  originalContracts: number;
  exitedContracts: number;
  entryCostCents: number;
  entryFeeCents: number;
  realizedExitProceedsCents: number;
  realizedExitFeesCents: number;
}
export function applyTarget75LotExit(
  lot: Target75LotAccounting,
  fill: { contracts: number; grossProceedsCents: number; feeCents: number },
): Target75LotAccounting & { remainingContracts: number; totalRealizedProfitNumerator: number; denominator: number } {
  const amounts=[lot.originalContracts,lot.exitedContracts,lot.entryCostCents,
    lot.entryFeeCents,lot.realizedExitProceedsCents,lot.realizedExitFeesCents,
    fill.contracts,fill.grossProceedsCents,fill.feeCents];
  if (amounts.some(n=>!Number.isSafeInteger(n)||n<0) ||
      lot.originalContracts<1 || lot.exitedContracts>lot.originalContracts ||
      fill.contracts<1 || fill.contracts>lot.originalContracts-lot.exitedContracts)
    throw new Error("invalid_target75_lot_fill");
  const exitedContracts=lot.exitedContracts+fill.contracts;
  const proceeds=lot.realizedExitProceedsCents+fill.grossProceedsCents;
  const fees=lot.realizedExitFeesCents+fill.feeCents;
  const denominator=lot.originalContracts;
  const totalRealizedProfitNumerator=
    (proceeds-fees)*denominator -
    (lot.entryCostCents+lot.entryFeeCents)*exitedContracts;
  if (![proceeds,fees,totalRealizedProfitNumerator].every(Number.isSafeInteger))
    throw new Error("target75_lot_overflow");
  return {
    ...lot,exitedContracts,realizedExitProceedsCents:proceeds,
    realizedExitFeesCents:fees,remainingContracts:denominator-exitedContracts,
    totalRealizedProfitNumerator,denominator,
  };
}
