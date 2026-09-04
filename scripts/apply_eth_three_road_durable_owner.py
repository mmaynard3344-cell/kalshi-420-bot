from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
store_path = ROOT / "artifacts/api-server/src/lib/tradeStore.ts"
source = store_path.read_text()

candidate_old = '''      const reservationSequence = Number((sequence as unknown as { rows: Array<Record<string, unknown>> }).rows[0]?.["value"]);
      if (!Number.isSafeInteger(reservationSequence) || reservationSequence < 1) return false;
      const inserted = await tx.execute(sql`
        INSERT INTO eth420_candidate_live_orders'''

candidate_new = '''      const reservationSequence = Number((sequence as unknown as { rows: Array<Record<string, unknown>> }).rows[0]?.["value"]);
      if (!Number.isSafeInteger(reservationSequence) || reservationSequence < 1) return false;

      // Three-road durable ownership: Regular already claims this same unique
      // (generation, ticker) row before its order reservation. Jump/Back Flip
      // now claim it too, using the deterministic candidate order id. The same
      // candidate id may retry its own proven-absent submission, but a different
      // Regular client id (or any other road owner) cannot take this ticker.
      const roadClaim = await tx.execute(sql`
        INSERT INTO eth_martingale_claims (generation, ticker, eastern_date, claimed_at_ms, client_order_id)
        VALUES (${ETH_MARTINGALE_ACTIVE_GENERATION_KEY}, ${params.ticker}, ${params.easternDate}, ${now}, ${params.id})
        ON CONFLICT (generation, ticker) DO UPDATE
          SET client_order_id = eth_martingale_claims.client_order_id
          WHERE eth_martingale_claims.client_order_id = EXCLUDED.client_order_id
        RETURNING ticker`);
      if ((roadClaim as unknown as { rows: unknown[] }).rows.length !== 1) return false;

      const inserted = await tx.execute(sql`
        INSERT INTO eth420_candidate_live_orders'''

count = source.count(candidate_old)
if count != 1:
    raise SystemExit(f"candidate durable-owner insertion count={count}")

store_path.write_text(source.replace(candidate_old, candidate_new))
