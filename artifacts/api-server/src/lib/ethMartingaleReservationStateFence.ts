import { pool } from "@workspace/db";

/**
 * Database-level last-line fence for Regular ETH reservations.
 *
 * The evaluator reads side/rung before entering reserveEthMartingaleEntry(). A
 * concurrent settlement can advance the authoritative state after that read but
 * before the reservation transaction inserts its order. The reservation already
 * updates/locks eth_martingale_state before inserting eth_martingale_orders, so
 * this trigger can compare the proposed immutable order snapshot with the state
 * row while that transaction owns the lock.
 *
 * On a mismatch we fail closed without throwing a storage error: remove this
 * exact ticker claim/proof fence, return the exact amount just reserved, and
 * suppress the stale order insert. The caller's subsequent post-start update
 * then finds no order row and therefore cannot reach Kalshi. A later evaluation
 * rereads the durable state and may reserve the correct rung.
 */
export async function ensureEthMartingaleReservationStateFence(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      CREATE OR REPLACE FUNCTION enforce_eth_martingale_reservation_state_fence()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      DECLARE
        state_date text;
        state_side text;
        state_step integer;
        release_cents integer;
      BEGIN
        IF NEW.generation <> 'ETH_NO_MARTINGALE_V2' THEN
          RETURN NEW;
        END IF;

        SELECT eastern_date, side, martingale_step
          INTO state_date, state_side, state_step
          FROM eth_martingale_state
         WHERE strategy_key = NEW.generation;

        IF NOT FOUND THEN
          RETURN NULL;
        END IF;

        IF state_date = NEW.eastern_date
           AND state_side = NEW.side
           AND state_step = NEW.martingale_step THEN
          RETURN NEW;
        END IF;

        release_cents :=
          (NEW.requested_contracts * NEW.no_price_cents) + NEW.reserved_fee_cents;

        UPDATE eth_martingale_state
           SET spent_cents = GREATEST(0, spent_cents - release_cents),
               updated_at_ms = GREATEST(updated_at_ms, NEW.created_at_ms)
         WHERE strategy_key = NEW.generation
           AND eastern_date = NEW.eastern_date;

        DELETE FROM eth_martingale_claims
         WHERE generation = NEW.generation
           AND ticker = NEW.ticker
           AND client_order_id = NEW.client_order_id;

        DELETE FROM eth_martingale_proof_fences
         WHERE generation = NEW.generation
           AND ticker = NEW.ticker
           AND client_order_id = NEW.client_order_id;

        RETURN NULL;
      END;
      $$;
    `);
    await client.query(`
      DROP TRIGGER IF EXISTS eth_martingale_reservation_state_fence
      ON eth_martingale_orders;
    `);
    await client.query(`
      CREATE TRIGGER eth_martingale_reservation_state_fence
      BEFORE INSERT ON eth_martingale_orders
      FOR EACH ROW
      EXECUTE FUNCTION enforce_eth_martingale_reservation_state_fence();
    `);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
