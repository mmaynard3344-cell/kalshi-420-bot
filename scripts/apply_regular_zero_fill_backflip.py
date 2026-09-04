from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

trade_store_path = ROOT / "artifacts/api-server/src/lib/tradeStore.ts"
trade_store = trade_store_path.read_text()

store_anchor = '''export async function getEth420CandidateBackFlipArm(targetOpenTimeMs: number): Promise<Eth420CandidateBackFlipArm | null> {'''
store_insert = r'''/**
 * Bridge the mutually-exclusive three-road router back into Back Flip ownership.
 * Ordinary windows are now owned by the regular ETH martingale, so its verified
 * zero-fill must be translated into the same durable one-window Back Flip arm
 * that candidate zero-fills already use.
 *
 * Returns null when storage is unavailable (caller must fail closed), "pending"
 * while the immediately-prior regular order has not yet reached authoritative
 * zero-fill settlement, "armed" once the override exists, and "none" when no
 * Back Flip is due.
 */
export async function ensureEth420BackFlipFromPriorRegular(
  targetOpenTimeMs: number,
): Promise<"armed" | "none" | "pending" | null> {
  if (!_db || !_healthy || !Number.isInteger(targetOpenTimeMs)
    || targetOpenTimeMs <= 0 || targetOpenTimeMs % 900_000 !== 0) return null;
  const sourceOpenTimeMs = targetOpenTimeMs - 900_000;
  try {
    return await _db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"eth-regular-zero-fill-backflip:" + targetOpenTimeMs}))`);
      const existing = await tx.execute(sql`
        SELECT source_candidate_order_id FROM eth420_candidate_back_flip_overrides
        WHERE target_open_time_ms=${targetOpenTimeMs} AND status IN ('armed','reserved') LIMIT 1`);
      if ((existing as unknown as { rows: unknown[] }).rows.length > 0) return "armed" as const;

      const priorResult = await tx.execute(sql`
        SELECT id, ticker, side, outcome, filled_contracts, settlement_result, created_at_ms,
               kalshi_order_id, rejection_reason
        FROM eth_martingale_orders
        WHERE generation=${ETH_MARTINGALE_ACTIVE_GENERATION_KEY}
          AND created_at_ms >= ${sourceOpenTimeMs}
          AND created_at_ms < ${targetOpenTimeMs}
        ORDER BY created_at_ms DESC
        LIMIT 1
        FOR UPDATE`);
      const prior = (priorResult as unknown as { rows: Array<Record<string, unknown>> }).rows[0];
      if (!prior) return "none" as const;

      const filled = prior["filled_contracts"] == null ? null : Number(prior["filled_contracts"]);
      const outcome = String(prior["outcome"] ?? "");
      if (filled != null && filled > 0) return "none" as const;
      if (outcome === "rejected" || outcome === "expired") return "none" as const;

      // Match the candidate Back Flip fence: do not arm from cancellation alone.
      // The regular order must have zero filled contracts AND an official YES/NO
      // settlement durably recorded by the regular lifecycle reconciler.
      const settlement = String(prior["settlement_result"] ?? "").toLowerCase();
      const authoritativeZeroFill = (outcome === "zero_fill" || outcome === "zero_fill_verified")
        && (settlement === "yes" || settlement === "no")
        && Number(prior["filled_contracts"] ?? 0) === 0;
      if (!authoritativeZeroFill) return "pending" as const;
      if (!prior["kalshi_order_id"] || (prior["side"] !== "yes" && prior["side"] !== "no")) return "pending" as const;

      const sourceId = `regular:${String(prior["id"])}`;
      await tx.execute(sql`INSERT INTO eth420_candidate_back_flip_overrides
        (source_candidate_order_id, source_ticker, source_open_time_ms, missed_side,
         target_open_time_ms, status, armed_at_ms)
        VALUES (${sourceId}, ${String(prior["ticker"])}, ${sourceOpenTimeMs}, ${String(prior["side"])},
          ${targetOpenTimeMs}, 'armed', ${Date.now()})
        ON CONFLICT (target_open_time_ms) DO NOTHING`);
      const armed = await tx.execute(sql`
        SELECT 1 FROM eth420_candidate_back_flip_overrides
        WHERE target_open_time_ms=${targetOpenTimeMs} AND status='armed' LIMIT 1`);
      return (armed as unknown as { rows: unknown[] }).rows.length > 0 ? "armed" as const : "pending" as const;
    });
  } catch (err) {
    logger.warn({ err, targetOpenTimeMs }, "tradeStore: regular zero-fill Back Flip bridge unavailable");
    return null;
  }
}

'''
if trade_store.count(store_anchor) != 1:
    raise SystemExit(f"tradeStore Back Flip anchor count={trade_store.count(store_anchor)}")
trade_store_path.write_text(trade_store.replace(store_anchor, store_insert + store_anchor))

candidate_path = ROOT / "artifacts/api-server/src/lib/strategies/eth420SixStepCandidate.ts"
candidate = candidate_path.read_text()

interface_anchor = '''  getEth420CandidateBackFlipArm?: (targetOpenTimeMs: number) => Promise<import("../tradeStore.js").Eth420CandidateBackFlipArm | null>;'''
interface_replacement = '''  ensureEth420BackFlipFromPriorRegular?: (targetOpenTimeMs: number) => Promise<"armed" | "none" | "pending" | null>;
  getEth420CandidateBackFlipArm?: (targetOpenTimeMs: number) => Promise<import("../tradeStore.js").Eth420CandidateBackFlipArm | null>;'''
if candidate.count(interface_anchor) != 1:
    raise SystemExit(f"candidate store interface anchor count={candidate.count(interface_anchor)}")
candidate = candidate.replace(interface_anchor, interface_replacement)

route_anchor = '''  const openTimeMs = candidateMarket.openTimeMs;
  let backFlip = Number.isInteger(openTimeMs) && store.getEth420CandidateBackFlipArm
    ? await store.getEth420CandidateBackFlipArm(openTimeMs!) : null;'''
route_replacement = '''  const openTimeMs = candidateMarket.openTimeMs;
  if (Number.isInteger(openTimeMs) && store.ensureEth420BackFlipFromPriorRegular) {
    const regularZeroFillBridge = await store.ensureEth420BackFlipFromPriorRegular(openTimeMs!);
    if (regularZeroFillBridge == null) {
      note("executor_blocked", "regular_zero_fill_bridge_unavailable");
      return false;
    }
    if (regularZeroFillBridge === "pending") {
      note("executor_blocked", "prior_regular_zero_fill_pending");
      return false;
    }
  }
  let backFlip = Number.isInteger(openTimeMs) && store.getEth420CandidateBackFlipArm
    ? await store.getEth420CandidateBackFlipArm(openTimeMs!) : null;'''
if candidate.count(route_anchor) != 1:
    raise SystemExit(f"candidate route anchor count={candidate.count(route_anchor)}")
candidate_path.write_text(candidate.replace(route_anchor, route_replacement))
