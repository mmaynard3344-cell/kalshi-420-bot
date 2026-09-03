import type { OrderAttemptRecord } from "./analytics.js";

const isFilled = (order: OrderAttemptRecord): boolean =>
  order.outcome === "full_fill" || order.outcome === "partial_fill";

const settlementEvidenceScore = (order: OrderAttemptRecord): number =>
  (order.outcomeReconciledAt != null ? 4 : 0) +
  (order.reconciled ? 2 : 0) +
  (order.fill_price_source === "actual" ? 1 : 0);

/**
 * One Kalshi order ID represents one exchange execution, even when local retry
 * records accidentally share it. Retain the strongest evidence; ties keep the
 * original local attempt.
 */
export function canonicalFilledOrders(orders: OrderAttemptRecord[]): OrderAttemptRecord[] {
  const byOrderId = new Map<string, OrderAttemptRecord>();
  const withoutOrderId: OrderAttemptRecord[] = [];

  for (const order of orders.filter(isFilled)) {
    if (!order.orderId) {
      withoutOrderId.push(order);
      continue;
    }
    const existing = byOrderId.get(order.orderId);
    if (!existing) {
      byOrderId.set(order.orderId, order);
      continue;
    }
    const scoreDiff = settlementEvidenceScore(order) - settlementEvidenceScore(existing);
    if (
      scoreDiff > 0 ||
      (scoreDiff === 0 && (
        order.attemptNumber < existing.attemptNumber ||
        (order.attemptNumber === existing.attemptNumber && order.timestampMs < existing.timestampMs)
      ))
    ) {
      byOrderId.set(order.orderId, order);
    }
  }
  return [...withoutOrderId, ...byOrderId.values()];
}

/**
 * Settlement write-path selector. A previously settled external order blocks
 * every duplicate retry, and otherwise exactly one earliest retry is eligible.
 */
export function canonicalUnreconciledFilledOrders(orders: OrderAttemptRecord[]): OrderAttemptRecord[] {
  const fills = orders.filter(isFilled);
  const settledOrderIds = new Set(
    fills
      .filter((order) => order.outcomeReconciledAt != null && order.orderId)
      .map((order) => order.orderId!),
  );
  const byOrderId = new Map<string, OrderAttemptRecord>();
  const withoutOrderId: OrderAttemptRecord[] = [];

  for (const order of fills) {
    if (order.outcomeReconciledAt != null) continue;
    if (!order.orderId) {
      withoutOrderId.push(order);
      continue;
    }
    if (settledOrderIds.has(order.orderId)) continue;
    const existing = byOrderId.get(order.orderId);
    if (
      !existing ||
      order.attemptNumber < existing.attemptNumber ||
      (order.attemptNumber === existing.attemptNumber && order.timestampMs < existing.timestampMs)
    ) {
      byOrderId.set(order.orderId, order);
    }
  }
  return [...withoutOrderId, ...byOrderId.values()];
}