import { createHash } from "node:crypto";
import { A2_FIXED_STAKE_CENTS, A2_MAX_ENTRY_PRICE_CENTS } from "./a2BaselineReversion.js";

export const A2_EXECUTION_STRATEGY = "A2" as const;
export const A2_EXECUTION_SLOT_ID = "a2-singleton" as const;

export type A2ExecutionState =
  | "EXPOSURE_LOCKED"
  | "PRICE_CONFIRMED"
  | "ORDER_INTENT_CREATED"
  | "DRY_RUN_READY"
  | "SUBMISSION_UNKNOWN"
  | "OPEN"
  | "PARTIALLY_FILLED"
  | "FILLED"
  | "REJECTED"
  | "PRICE_TOO_HIGH"
  | "EXPIRED_UNSUBMITTED"
  | "SETTLED_WIN"
  | "SETTLED_LOSS"
  | "EXPOSURE_RELEASED";

export interface A2ExecutionIntent {
  id: string;
  signalId: string;
  marketTicker: string;
  side: "yes";
  action: "buy";
  stakeCents: 500;
  maxEntryPriceCents: 45;
  clientOrderId: string;
  state: A2ExecutionState;
  executableYesPriceCents: number | null;
  quantity: number | null;
  maxNotionalCents: number | null;
  priceCheckedAtMs: number | null;
  kalshiOrderId: string | null;
  filledQuantity: number;
  fillCostCents: number;
  fillFeeCents: number;
}

export interface A2DryRunPayload {
  ticker: string;
  client_order_id: string;
  type: "limit";
  action: "buy";
  side: "yes";
  count: number;
  yes_price: number;
  time_in_force: "good_till_canceled";
}

export interface A2DryRunReceipt {
  mode: "dry_run";
  submission_performed: false;
  would_submit: boolean;
  blockers: string[];
  order_payload: A2DryRunPayload | null;
  intent_id: string | null;
}

export interface A2ExchangeOrder {
  orderId: string;
  clientOrderId: string;
  status: "open" | "partially_filled" | "filled" | "canceled" | "rejected";
  filledCount: number;
}

export interface A2ExchangeFill {
  fillId: string;
  orderId: string;
  count: number;
  yesPriceCents: number;
  feeCents: number;
}

export interface A2ExchangeClient {
  getExecutableYesPrice(ticker: string): Promise<number | null>;
  findOrder(clientOrderId: string): Promise<A2ExchangeOrder | null>;
  listFills(orderId: string): Promise<A2ExchangeFill[]>;
  getMarketResult(ticker: string): Promise<"yes" | "no" | null>;
  buildOrderPayload(intent: {
    ticker: string;
    clientOrderId: string;
    count: number;
    yesPriceCents: number;
  }): A2DryRunPayload;
}

export type A2AcquireResult =
  | { outcome: "acquired"; intent: A2ExecutionIntent }
  | { outcome: "duplicate"; intent: A2ExecutionIntent }
  | { outcome: "active_exposure_limit"; intent: null }
  | { outcome: "store_unavailable"; intent: null };

export interface A2ExecutionStore {
  acquireExposure(input: {
    id: string;
    signalId: string;
    marketTicker: string;
    clientOrderId: string;
    nowMs: number;
  }): Promise<A2AcquireResult>;
  markDryRunReady(input: {
    id: string;
    executableYesPriceCents: number;
    quantity: number;
    maxNotionalCents: number;
    priceCheckedAtMs: number;
    payload: A2DryRunPayload;
  }): Promise<boolean>;
  releaseUnsubmitted(input: {
    id: string;
    terminalState: "PRICE_TOO_HIGH" | "EXPIRED_UNSUBMITTED" | "REJECTED";
    reason: string;
    nowMs: number;
  }): Promise<boolean>;
  markSubmissionUnknown(input: { id: string; nowMs: number }): Promise<boolean>;
  adoptExchangeOrder(input: {
    id: string;
    orderId: string;
    state: "OPEN" | "PARTIALLY_FILLED" | "FILLED";
    filledQuantity: number;
    fillCostCents: number;
    fillFeeCents: number;
    fills: A2ExchangeFill[];
    nowMs: number;
  }): Promise<boolean>;
  settleAndRelease(input: {
    id: string;
    result: "yes" | "no";
    realizedPnlCents: number;
    nowMs: number;
  }): Promise<boolean>;
  getIntentByClientOrderId(clientOrderId: string): Promise<A2ExecutionIntent | null>;
}

function safePart(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 48);
}

export function deterministicA2ClientOrderId(input: {
  marketTicker: string;
  signalId: string;
  orderVersion?: number;
}): string {
  const version = input.orderVersion ?? 1;
  const digest = createHash("sha256")
    .update(`${input.marketTicker}|${input.signalId}|${version}`)
    .digest("hex")
    .slice(0, 16);
  return `a2-${safePart(input.marketTicker)}-${digest}-v${version}`;
}

export function sizeA2Order(executableYesPriceCents: number): {
  quantity: number;
  maxNotionalCents: number;
} | null {
  if (!Number.isInteger(executableYesPriceCents)
    || executableYesPriceCents < 1
    || executableYesPriceCents > A2_MAX_ENTRY_PRICE_CENTS) return null;
  const quantity = Math.floor(A2_FIXED_STAKE_CENTS / executableYesPriceCents);
  if (quantity < 1) return null;
  const maxNotionalCents = quantity * executableYesPriceCents;
  if (maxNotionalCents > A2_FIXED_STAKE_CENTS) return null;
  return { quantity, maxNotionalCents };
}

export class A2DryRunExecutionAdapter {
  constructor(
    private readonly store: A2ExecutionStore,
    private readonly exchange: A2ExchangeClient,
  ) {}

  async prepare(input: {
    signalId: string;
    marketTicker: string;
    nowMs: number;
  }): Promise<A2DryRunReceipt> {
    const clientOrderId = deterministicA2ClientOrderId(input);
    const intentId = `a2-intent:${clientOrderId}`;
    const acquired = await this.store.acquireExposure({
      id: intentId,
      signalId: input.signalId,
      marketTicker: input.marketTicker,
      clientOrderId,
      nowMs: input.nowMs,
    });
    if (acquired.outcome === "active_exposure_limit") {
      return { mode: "dry_run", submission_performed: false, would_submit: false, blockers: ["active_exposure_limit"], order_payload: null, intent_id: null };
    }
    if (acquired.outcome === "store_unavailable") {
      return { mode: "dry_run", submission_performed: false, would_submit: false, blockers: ["store_unavailable"], order_payload: null, intent_id: null };
    }
    if (acquired.outcome === "duplicate" && acquired.intent.state === "DRY_RUN_READY") {
      return {
        mode: "dry_run", submission_performed: false, would_submit: true, blockers: [],
        order_payload: acquired.intent.quantity && acquired.intent.executableYesPriceCents
          ? this.exchange.buildOrderPayload({
              ticker: acquired.intent.marketTicker,
              clientOrderId: acquired.intent.clientOrderId,
              count: acquired.intent.quantity,
              yesPriceCents: acquired.intent.executableYesPriceCents,
            })
          : null,
        intent_id: acquired.intent.id,
      };
    }

    const price = await this.exchange.getExecutableYesPrice(input.marketTicker);
    const sizing = price == null ? null : sizeA2Order(price);
    if (!sizing) {
      await this.store.releaseUnsubmitted({
        id: acquired.intent.id,
        terminalState: price != null && price > A2_MAX_ENTRY_PRICE_CENTS ? "PRICE_TOO_HIGH" : "EXPIRED_UNSUBMITTED",
        reason: price == null ? "executable_yes_price_unavailable" : `yes_price_${price}_above_cap`,
        nowMs: input.nowMs,
      });
      return {
        mode: "dry_run", submission_performed: false, would_submit: false,
        blockers: [price == null ? "executable_yes_price_unavailable" : "entry_price_above_cap"],
        order_payload: null, intent_id: acquired.intent.id,
      };
    }

    const payload = this.exchange.buildOrderPayload({
      ticker: input.marketTicker,
      clientOrderId,
      count: sizing.quantity,
      yesPriceCents: price!,
    });
    const persisted = await this.store.markDryRunReady({
      id: acquired.intent.id,
      executableYesPriceCents: price!,
      quantity: sizing.quantity,
      maxNotionalCents: sizing.maxNotionalCents,
      priceCheckedAtMs: input.nowMs,
      payload,
    });
    if (!persisted) {
      return { mode: "dry_run", submission_performed: false, would_submit: false, blockers: ["store_unavailable"], order_payload: null, intent_id: acquired.intent.id };
    }
    return {
      mode: "dry_run",
      submission_performed: false,
      would_submit: true,
      blockers: [],
      order_payload: payload,
      intent_id: acquired.intent.id,
    };
  }

  async reconcileUnknown(
    clientOrderId: string,
    nowMs: number,
    definitiveNoMatch = false,
  ): Promise<"adopted" | "released_unsubmitted" | "not_found" | "store_unavailable"> {
    const intent = await this.store.getIntentByClientOrderId(clientOrderId);
    if (!intent) return "not_found";
    const order = await this.exchange.findOrder(clientOrderId);
    if (!order) {
      if (!definitiveNoMatch) return "not_found";
      return await this.store.releaseUnsubmitted({
        id: intent.id,
        terminalState: "EXPIRED_UNSUBMITTED",
        reason: "reconciliation_window_exhausted_no_exchange_order",
        nowMs,
      }) ? "released_unsubmitted" : "store_unavailable";
    }

    const fills = await this.exchange.listFills(order.orderId);
    const filledQuantity = fills.reduce((sum, fill) => sum + fill.count, 0);
    const fillCostCents = fills.reduce((sum, fill) => sum + fill.count * fill.yesPriceCents, 0);
    const fillFeeCents = fills.reduce((sum, fill) => sum + fill.feeCents, 0);
    const intendedQuantity = intent.quantity ?? 0;
    const mapped = filledQuantity > 0 && intendedQuantity > 0 && filledQuantity >= intendedQuantity
      ? "FILLED"
      : filledQuantity > 0
        ? "PARTIALLY_FILLED"
        : "OPEN";
    return await this.store.adoptExchangeOrder({
      id: intent.id,
      orderId: order.orderId,
      state: mapped,
      filledQuantity,
      fillCostCents,
      fillFeeCents,
      fills,
      nowMs,
    }) ? "adopted" : "store_unavailable";
  }

  async settle(clientOrderId: string, nowMs: number): Promise<"settled" | "pending" | "not_found" | "store_unavailable"> {
    const intent = await this.store.getIntentByClientOrderId(clientOrderId);
    if (!intent) return "not_found";
    const result = await this.exchange.getMarketResult(intent.marketTicker);
    if (!result) return "pending";
    const hasFillEvidence = intent.filledQuantity > 0;
    const quantity = hasFillEvidence ? intent.filledQuantity : (intent.quantity ?? 0);
    const costCents = hasFillEvidence
      ? intent.fillCostCents + intent.fillFeeCents
      : (intent.maxNotionalCents ?? 0);
    const pnl = result === "yes"
      ? quantity * 100 - costCents
      : -costCents;
    return await this.store.settleAndRelease({ id: intent.id, result, realizedPnlCents: pnl, nowMs })
      ? "settled" : "store_unavailable";
  }
}

export class A2ReadOnlyDryRunClient implements A2ExchangeClient {
  constructor(
    private readonly priceReader: (ticker: string) => Promise<number | null>,
    private readonly marketResultReader: (ticker: string) => Promise<"yes" | "no" | null>,
    private readonly orderReader: (clientOrderId: string) => Promise<A2ExchangeOrder | null> = async () => null,
    private readonly fillReader: (orderId: string) => Promise<A2ExchangeFill[]> = async () => [],
  ) {}

  getExecutableYesPrice(ticker: string): Promise<number | null> { return this.priceReader(ticker); }
  findOrder(clientOrderId: string): Promise<A2ExchangeOrder | null> { return this.orderReader(clientOrderId); }
  listFills(orderId: string): Promise<A2ExchangeFill[]> { return this.fillReader(orderId); }
  getMarketResult(ticker: string): Promise<"yes" | "no" | null> { return this.marketResultReader(ticker); }
  buildOrderPayload(input: { ticker: string; clientOrderId: string; count: number; yesPriceCents: number }): A2DryRunPayload {
    return {
      ticker: input.ticker,
      client_order_id: input.clientOrderId,
      type: "limit",
      action: "buy",
      side: "yes",
      count: input.count,
      yes_price: input.yesPriceCents,
      time_in_force: "good_till_canceled",
    };
  }
}
