from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
trade_store_path = ROOT / "artifacts/api-server/src/lib/tradeStore.ts"
source = trade_store_path.read_text()

old = '''export async function advanceEthMartingaleLadderForZeroFill(
  id: string, result: "yes" | "no",
): Promise<boolean> {
  if (!_db || !_healthy) return false;
  const now = Date.now();
  try {
    return await _db.transaction(async (tx) => {
      const settled = await tx.execute(sql`
        UPDATE eth_martingale_orders
        SET settlement_result=${result}, settled_at_ms=${now}, updated_at_ms=${now}
        WHERE id=${id} AND settlement_result IS NULL AND outcome = 'zero_fill'
          AND generation=${ETH_MARTINGALE_ACTIVE_GENERATION_KEY}
          AND created_at_ms >= ${ETH_MARTINGALE_ACTIVE_GENERATION_STARTED_AT_MS}
        RETURNING martingale_step, side, eastern_date`);
      const row = (settled as unknown as {
        rows: Array<{ martingale_step: number; side: string; eastern_date: string }>;
      }).rows[0];
      if (!row) return false;

      const orderSide: "yes" | "no" = row.side === "yes" ? "yes" : "no";
      const won = result === orderSide;
      const orderStep = Number(row.martingale_step);
      const nextStep = won ? 0 : orderStep >= 2 ? 0 : orderStep + 1;
      const nextSide: "yes" | "no" = won ? (orderSide === "yes" ? "no" : "yes") : orderSide;

      await tx.execute(sql`
        UPDATE eth_martingale_state
        SET side=${nextSide}, martingale_step=${nextStep}, updated_at_ms=${now}
        WHERE strategy_key=${ETH_MARTINGALE_ACTIVE_GENERATION_KEY}
          AND eastern_date=${row.eastern_date}`);
      return true;
    });
  } catch (err) {
    logger.warn({ err, id }, "eth: zero-fill ladder advance failed");
    return false;
  }
}'''

new = '''export async function advanceEthMartingaleLadderForZeroFill(
  id: string, result: "yes" | "no",
): Promise<boolean> {
  if (!_db || !_healthy) return false;
  const now = Date.now();
  try {
    return await _db.transaction(async (tx) => {
      const settled = await tx.execute(sql`
        UPDATE eth_martingale_orders
        SET settlement_result=${result}, settled_at_ms=${now}, updated_at_ms=${now}
        WHERE id=${id} AND settlement_result IS NULL AND outcome = 'zero_fill'
          AND generation=${ETH_MARTINGALE_ACTIVE_GENERATION_KEY}
          AND created_at_ms >= ${ETH_MARTINGALE_ACTIVE_GENERATION_STARTED_AT_MS}
        RETURNING martingale_step, side, eastern_date, ticker, created_at_ms`);
      const row = (settled as unknown as {
        rows: Array<{ martingale_step: number; side: string; eastern_date: string; ticker: string; created_at_ms: number }>;
      }).rows[0];
      if (!row) return false;

      const orderSide: "yes" | "no" = row.side === "yes" ? "yes" : "no";
      const won = result === orderSide;
      const orderStep = Number(row.martingale_step);
      const nextStep = won ? 0 : orderStep >= 2 ? 0 : orderStep + 1;
      const nextSide: "yes" | "no" = won ? (orderSide === "yes" ? "no" : "yes") : orderSide;

      await tx.execute(sql`
        UPDATE eth_martingale_state
        SET side=${nextSide}, martingale_step=${nextStep}, updated_at_ms=${now}
        WHERE strategy_key=${ETH_MARTINGALE_ACTIVE_GENERATION_KEY}
          AND eastern_date=${row.eastern_date}`);

      // A regular zero-fill is the authoritative trigger for the one-window
      // Back Flip. Arm it in the same transaction as official settlement so
      // the next router pass can never see settlement without the arm.
      const sourceOpenTimeMs = Math.floor(Number(row.created_at_ms) / 900_000) * 900_000;
      const targetOpenTimeMs = sourceOpenTimeMs + 900_000;
      if (Number.isSafeInteger(sourceOpenTimeMs) && sourceOpenTimeMs > 0) {
        const sourceId = `regular:${id}`;
        await tx.execute(sql`INSERT INTO eth420_candidate_back_flip_overrides
          (source_candidate_order_id, source_ticker, source_open_time_ms, missed_side,
           target_open_time_ms, status, armed_at_ms)
          VALUES (${sourceId}, ${row.ticker}, ${sourceOpenTimeMs}, ${orderSide},
            ${targetOpenTimeMs}, 'armed', ${now})
          ON CONFLICT (target_open_time_ms) DO NOTHING`);
      }
      return true;
    });
  } catch (err) {
    logger.warn({ err, id }, "eth: zero-fill ladder advance failed");
    return false;
  }
}'''

count = source.count(old)
if count != 1:
    raise SystemExit(f"regular zero-fill settlement replacement count={count}")
trade_store_path.write_text(source.replace(old, new))
