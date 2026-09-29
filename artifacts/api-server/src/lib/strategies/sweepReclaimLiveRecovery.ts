import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { kalshiAuthFetch } from "../kalshiAuth.js";
import { updateSweepReclaimClaim } from "../tradeStore.js";
import { readEthBigBetTerminalExposureEvidence, type EthBigBetSettlementRow } from "./ethBigBetSettlementReconciler.js";
import { transitionProductionEthLongReversalBySourceOrderId } from "./ethLongReversalExposure.js";

export interface LRecoveryRow extends EthBigBetSettlementRow {
  clientOrderId: string;
  exchangeIndex: number;
}
type AuthRead = <T>(method: string, path: string) => Promise<T>;
export interface LRecoveryDeps {
  rows(): Promise<LRecoveryRow[]>;
  read: AuthRead;
  update: typeof updateSweepReclaimClaim;
  release: typeof transitionProductionEthLongReversalBySourceOrderId;
}
const productionDeps: LRecoveryDeps = {
  async rows() {
    const result = await db.execute(sql`
      SELECT c.id, c.destination_ticker AS ticker, c.side,
        c.kalshi_order_id AS "kalshiOrderId", c.client_order_id AS "clientOrderId",
        r.exchange_index AS "exchangeIndex"
      FROM sweep_reclaim_claims c
      JOIN eth_long_reversal_reservations r ON r.source_order_id = c.id AND r.service = 'L'
      WHERE r.state IN ('reserved','submitted','submission_unknown','filled_unsettled')
        AND c.lifecycle_state IN ('SUBMITTING','SUBMISSION_UNKNOWN','SUBMITTED','PARTIALLY_FILLED','FILLED','RECONCILING','SETTLED','CANCELED')
      ORDER BY c.claimed_at_ms LIMIT 100
    `);
    return (result as unknown as { rows: LRecoveryRow[] }).rows;
  },
  read: kalshiAuthFetch,
  update: updateSweepReclaimClaim,
  release: transitionProductionEthLongReversalBySourceOrderId,
};

export async function reconcileLSweepReclaimOrders(deps = productionDeps): Promise<void> {
  for (const row of await deps.rows()) {
    if (!row.clientOrderId || row.clientOrderId !== row.id || row.side !== "yes"
      || !Number.isInteger(row.exchangeIndex) || row.exchangeIndex < 0) continue;
    // Scope every portfolio read to the same exchange used for submission and
    // reject any response whose identity differs from the permanent claim.
    const seenFills = new Set<string>();
    let trustedOrderId = row.kalshiOrderId;
    const read: AuthRead = async <T>(method: string, path: string): Promise<T> => {
      if (method !== "GET") throw new Error("L recovery is read-only at the exchange");
      const scoped = path.startsWith("/portfolio/") ? `${path}${path.includes("?") ? "&" : "?"}exchange_index=${row.exchangeIndex}` : path;
      const response = await deps.read<Record<string, unknown>>(method, scoped);
      const validate = (order: any) => {
        if (order?.ticker !== row.ticker || order?.client_order_id !== row.clientOrderId
          || (row.kalshiOrderId && order?.order_id !== row.kalshiOrderId)) throw new Error("L order identity mismatch");
        trustedOrderId = order.order_id;
      };
      if (response["order"]) validate(response["order"]);
      if (Array.isArray(response["orders"])) response["orders"].forEach(validate);
      if (Array.isArray(response["fills"])) {
        response["fills"] = response["fills"].filter((fill: any) => {
          if (fill.ticker !== row.ticker || !fill.order_id
            || fill.order_id !== trustedOrderId
            || !fill.fill_id || fill.side !== "yes" || fill.action !== "buy") throw new Error("L fill identity mismatch");
          if (seenFills.has(fill.fill_id)) return false;
          seenFills.add(fill.fill_id);
          return true;
        });
      }
      return response as T;
    };
    try {
      const evidence = await readEthBigBetTerminalExposureEvidence({ row, authFetch: read });
      if (!evidence) continue; // Resting, ambiguous, and incomplete fills retain the full reservation.
      let result: "yes" | "no" | null = null;
      if (!evidence.terminalZeroFill) {
        const response = await read<{ market?: { ticker?: string; result?: string } }>("GET", `/markets/${encodeURIComponent(row.ticker)}`);
        if (response.market?.ticker !== row.ticker) continue;
        result = response.market.result === "yes" || response.market.result === "no" ? response.market.result : null;
        if (!result) continue;
      }
      const pnl = evidence.terminalZeroFill ? 0 : (result === "yes" ? evidence.filledContracts * 100 : 0)
        - evidence.actualNotionalCents - evidence.actualFeeCents;
      if (!Number.isSafeInteger(pnl)) continue;
      const written = await deps.update({ id: row.id, lifecycleState: evidence.terminalZeroFill ? "CANCELED" : "SETTLED",
        filledContracts: evidence.filledContracts,
        averageFillPriceCents: evidence.filledContracts ? Math.round(evidence.actualNotionalCents / evidence.filledContracts) : null,
        actualFeeCents: evidence.actualFeeCents, settlementResult: result, realizedPnlCents: pnl });
      if (!written) continue;
      await deps.release({ sourceOrderId: row.id, to: evidence.terminalZeroFill ? "released" : "settled" });
    } catch { /* Missing authoritative evidence retains risk for the next poll. */ }
  }
}
