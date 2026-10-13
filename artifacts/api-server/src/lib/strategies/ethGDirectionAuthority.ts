import { sql } from "drizzle-orm";
import { logger } from "../logger.js";
import type { EthBigBetOrderIntent } from "./ethBigBetLifecycle.js";

export type EthGMarketDecision = { exists: boolean; side: "yes" | "no" | null };
export type EthGDirectionLookup = (ticker: string) => Promise<EthGMarketDecision>;

export function resolveEthGDirection(originalSide: "yes" | "no", gSide: "yes" | "no" | null): "yes" | "no" {
  return gSide ?? originalSide;
}

async function readGDirection(ticker: string): Promise<EthGMarketDecision> {
  const { db } = await import("@workspace/db");
  const result = await db.execute(sql`SELECT side FROM eth_g_market_directions WHERE ticker=${ticker} LIMIT 1`);
  const rows = Array.isArray(result) ? result : (result as {rows?: unknown[]}).rows ?? [];
  const row = rows[0] as {side?: unknown} | undefined;
  if (!row) return { exists: false, side: null };
  if (row.side !== null && row.side !== "yes" && row.side !== "no") throw new Error("Invalid G direction");
  return { exists: true, side: row.side as "yes" | "no" | null };
}

/**
 * G publishes a final YES, NO or NONE for each completed-history ETH market.
 * Until that immutable record exists, other ETH services defer submission.
 * The feature flag stays off until the publisher and all consumers are deployed.
 */
export async function alignEthIntentToG(
  intent: EthBigBetOrderIntent,
  lookup?: EthGDirectionLookup,
): Promise<EthBigBetOrderIntent | null> {
  if (process.env["ETH_G_DIRECTION_AUTHORITY_ENABLED"] !== "true" && !lookup) return intent;
  try {
    const decision = await (lookup ?? readGDirection)(intent.ticker);
    if (!decision.exists) {
      logger.info({event:"ETH_G_DIRECTION_PENDING",strategy:intent.strategy,ticker:intent.ticker}, "Awaiting final G market decision");
      return null;
    }
    const side = resolveEthGDirection(intent.side, decision.side);
    if (side !== intent.side) {
      logger.info({event:"ETH_G_DIRECTION_OVERRIDE",strategy:intent.strategy,ticker:intent.ticker,originalSide:intent.side,gSide:side}, "Following G market direction");
    }
    return { ...intent, side };
  } catch (error) {
    logger.error({event:"ETH_G_DIRECTION_READ_FAILED",strategy:intent.strategy,ticker:intent.ticker,error}, "Deferring ETH order after failed G direction read");
    return null;
  }
}
