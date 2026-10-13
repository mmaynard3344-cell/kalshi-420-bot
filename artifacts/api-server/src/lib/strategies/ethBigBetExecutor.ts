import { logger } from "../logger.js";
import type { EthAccountCapitalInput } from "./ethAccountCapitalGuard.js";
import { ethBigBetContracts, ethBigBetOrderId, mayEvaluateBigBetMarket, type EthBigBetOrderIntent } from "./ethBigBetLifecycle.js";
export type EthBigBetExecutionReservationResult = "reserved" | "capital_blocked" | "reservation_failed";
export interface EthBigBetExecutionStore { listUnresolvedEthBigBetOrderIds(strategy: EthBigBetOrderIntent["strategy"]): Promise<string[]>; reserveEthBigBetOrder(input: { orderId: string; intent: EthBigBetOrderIntent; requestedContracts: number; requestedRiskCents: number; capital: Omit<EthAccountCapitalInput, "requestedRiskCents">; reservedAtMs: number; }): Promise<EthBigBetExecutionReservationResult>; acknowledgeEthBigBetOrder(input: { orderId: string; exchangeOrderId: string | null; status: "submitted" | "submission_unknown" | "rejected"; acknowledgedAtMs: number; }): Promise<boolean>; }
export type EthBigBetSubmitResult = { kind: "accepted"; exchangeOrderId: string } | { kind: "rejected"; reason: string } | { kind: "unknown" };
export interface EthBigBetExchangeSubmitter { submit(input: { clientOrderId: string; ticker: string; side: "yes" | "no"; contracts: number; limitPriceCents: number; }): Promise<EthBigBetSubmitResult>; }
const ACK_RETRY_DELAYS_MS = [0, 250, 1_000] as const;
function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function acknowledgeDurably(store: EthBigBetExecutionStore, input: Parameters<EthBigBetExecutionStore["acknowledgeEthBigBetOrder"]>[0]): Promise<boolean> { for (const delay of ACK_RETRY_DELAYS_MS) { if (delay > 0) await sleep(delay); try { if (await store.acknowledgeEthBigBetOrder({ ...input, acknowledgedAtMs: Date.now() })) return true; } catch {} } return false; }
export async function submitEthBigBetIntent(input: { intent: EthBigBetOrderIntent; store: EthBigBetExecutionStore; exchange: EthBigBetExchangeSubmitter; capital: Omit<EthAccountCapitalInput, "requestedRiskCents">; requestedRiskCents: number; nowMs?: number; }): Promise<"submitted" | "blocked_duplicate" | "blocked_invalid_size" | "capital_blocked" | "reservation_failed" | "submission_unknown" | "rejected"> { let effectiveIntent = input.intent;
  // Use the same persisted G ticker decision across independent ETH workers.
  // No G decision for this ticker leaves the existing service direction untouched.
  try {
    const { sql } = await import("drizzle-orm");
    const { db } = await import("@workspace/db");
    const result = await db.execute(sql`SELECT side FROM eth_g_streak_reversal_orders WHERE ticker=${input.intent.ticker} AND status NOT IN ('rejected','canceled','cancelled') LIMIT 1`);
    const rows = Array.isArray(result) ? result : (result as {rows?: unknown[]}).rows ?? [];
    const row = rows[0] as {side?: unknown} | undefined;
    if (row?.side === "yes" || row?.side === "no") {
      if (row.side !== input.intent.side) {
        logger.info({event:"ETH_G_DIRECTION_OVERRIDE",strategy:input.intent.strategy,ticker:input.intent.ticker,originalSide:input.intent.side,gSide:row.side},"ETH service follows G direction");
        effectiveIntent = {...input.intent,side:row.side};
      }
    }
  } catch (error) {
    logger.error({event:"ETH_G_DIRECTION_LOOKUP_FAILED",ticker:input.intent.ticker,strategy:input.intent.strategy,error},"Blocking ETH order because G directional authority is unavailable");
    return "reservation_failed";
  }
  const orderId=ethBigBetOrderId(effectiveIntent); const unresolved=await input.store.listUnresolvedEthBigBetOrderIds(effectiveIntent.strategy); if(!mayEvaluateBigBetMarket({targetOrderId:orderId,unresolvedOrderIds:unresolved})) return "blocked_duplicate"; const contracts=ethBigBetContracts(effectiveIntent.wagerCents,effectiveIntent.limitPriceCents); if(contracts<1||!Number.isSafeInteger(input.requestedRiskCents)||input.requestedRiskCents<1) return "blocked_invalid_size"; const reservation=await input.store.reserveEthBigBetOrder({orderId,intent:effectiveIntent,requestedContracts:contracts,requestedRiskCents:input.requestedRiskCents,capital:input.capital,reservedAtMs:input.nowMs??Date.now()}); if(reservation==="capital_blocked") return "capital_blocked"; if(reservation!=="reserved") return "reservation_failed"; try { const submitted=await input.exchange.submit({clientOrderId:orderId,ticker:effectiveIntent.ticker,side:effectiveIntent.side,contracts,limitPriceCents:effectiveIntent.limitPriceCents}); if(submitted.kind==="accepted"){ if(await acknowledgeDurably(input.store,{orderId,exchangeOrderId:submitted.exchangeOrderId,status:"submitted",acknowledgedAtMs:Date.now()})) { logger.info({event:"ETH_SERVICE_ORDER_ATTRIBUTION",strategy:effectiveIntent.strategy,serviceRole:effectiveIntent.strategy,ticker:effectiveIntent.ticker,side:effectiveIntent.side,clientOrderId:orderId,exchangeOrderId:submitted.exchangeOrderId,contracts,limitPriceCents:effectiveIntent.limitPriceCents,wagerCents:effectiveIntent.wagerCents,executionStatus:"submitted"}, "ETH service order attribution"); return "submitted"; } await acknowledgeDurably(input.store,{orderId,exchangeOrderId:null,status:"submission_unknown",acknowledgedAtMs:Date.now()}); return "submission_unknown";} if(submitted.kind==="rejected") return await acknowledgeDurably(input.store,{orderId,exchangeOrderId:null,status:"rejected",acknowledgedAtMs:Date.now()})?"rejected":"submission_unknown"; await acknowledgeDurably(input.store,{orderId,exchangeOrderId:null,status:"submission_unknown",acknowledgedAtMs:Date.now()}); return "submission_unknown";} catch { await acknowledgeDurably(input.store,{orderId,exchangeOrderId:null,status:"submission_unknown",acknowledgedAtMs:Date.now()}); return "submission_unknown"; } }
