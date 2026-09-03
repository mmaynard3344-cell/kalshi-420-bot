/**
 * The exchange-order endpoint is read-only in ETH-only trading mode. New
 * entries must use the ETH martingale's reservation, sizing, and final
 * permission lifecycle rather than accepting arbitrary browser parameters.
 */
export function isManualNewOrderSubmissionDisabled(): true {
  return true;
}
