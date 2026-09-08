import pg from "../../../lib/db/node_modules/pg/lib/index.js";

const { Client } = pg;
const STRATEGY = "ETH_NO_MARTINGALE_V2";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required for Regular sequence guard installation");
}

const client = new Client({ connectionString });
await client.connect();

try {
  await client.query("BEGIN");

  // Canonical Regular sequence is reconstructed from immutable, settled,
  // positive-fill V2 ledger rows. The recorded martingale_step on an order is
  // deliberately NOT used to advance the sequence; that makes a previously
  // mis-rung order incapable of poisoning every subsequent rung.
  await client.query(`
    CREATE OR REPLACE FUNCTION eth_v2_canonical_sequence(p_eastern_date text)
    RETURNS TABLE(expected_side text, expected_step integer)
    LANGUAGE plpgsql
    AS $$
    DECLARE
      r record;
      c_side text := 'no';
      c_step integer := 0;
    BEGIN
      FOR r IN
        SELECT side, settlement_result
        FROM eth_martingale_orders
        WHERE generation = 'ETH_NO_MARTINGALE_V2'
          AND eastern_date = p_eastern_date
          AND settlement_result IN ('yes', 'no')
          AND COALESCE(filled_contracts, 0) > 0
        ORDER BY created_at_ms ASC, id ASC
      LOOP
        IF r.settlement_result = r.side THEN
          c_side := CASE WHEN r.side = 'yes' THEN 'no' ELSE 'yes' END;
          c_step := 0;
        ELSE
          c_side := r.side;
          c_step := CASE WHEN c_step >= 5 THEN 0 ELSE c_step + 1 END;
        END IF;
      END LOOP;

      expected_side := c_side;
      expected_step := c_step;
      RETURN NEXT;
    END;
    $$;
  `);

  // Every update to the active Regular state is canonicalized from the settled
  // ledger in the same transaction. Settlement updates therefore see their own
  // just-written settlement_result, while reservations see the latest committed
  // sequence. No alternate writer can force a same-day reset to Step 1.
  await client.query(`
    CREATE OR REPLACE FUNCTION enforce_eth_v2_canonical_state()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    DECLARE
      c_side text;
      c_step integer;
    BEGIN
      IF NEW.strategy_key <> 'ETH_NO_MARTINGALE_V2' THEN
        RETURN NEW;
      END IF;

      SELECT expected_side, expected_step
      INTO c_side, c_step
      FROM eth_v2_canonical_sequence(NEW.eastern_date);

      IF c_side IS NULL OR c_step IS NULL OR c_step < 0 OR c_step > 5 THEN
        RAISE EXCEPTION 'ETH V2 canonical sequence unavailable for %', NEW.eastern_date;
      END IF;

      NEW.side := c_side;
      NEW.martingale_step := c_step;
      RETURN NEW;
    END;
    $$;
  `);

  await client.query(`DROP TRIGGER IF EXISTS eth_v2_canonical_state_guard ON eth_martingale_state`);
  await client.query(`
    CREATE TRIGGER eth_v2_canonical_state_guard
    BEFORE UPDATE ON eth_martingale_state
    FOR EACH ROW
    WHEN (OLD.strategy_key = 'ETH_NO_MARTINGALE_V2')
    EXECUTE FUNCTION enforce_eth_v2_canonical_state()
  `);

  // Repair the active row immediately from the immutable settled ledger. This
  // is safe even when an order is unresolved: the trading engine already blocks
  // a successor while unresolved exposure exists, and settlement will then
  // advance canonically through the trigger above.
  const repair = await client.query(`
    UPDATE eth_martingale_state s
    SET side = c.expected_side,
        martingale_step = c.expected_step,
        updated_at_ms = (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint
    FROM LATERAL eth_v2_canonical_sequence(s.eastern_date) c
    WHERE s.strategy_key = $1
    RETURNING s.eastern_date, s.side, s.martingale_step, s.realized_pnl_cents
  `, [STRATEGY]);

  if (repair.rowCount !== 1) {
    throw new Error(`Expected exactly one ${STRATEGY} state row, repaired ${repair.rowCount}`);
  }

  await client.query("COMMIT");

  const state = repair.rows[0];
  const orders = await client.query(`
    SELECT ticker, side, martingale_step, settlement_result, created_at_ms
    FROM eth_martingale_orders
    WHERE generation = $1
      AND eastern_date = $2
      AND settlement_result IN ('yes', 'no')
      AND COALESCE(filled_contracts, 0) > 0
    ORDER BY created_at_ms ASC, id ASC
  `, [STRATEGY, state.eastern_date]);

  let expectedSide = "no";
  let expectedStep = 0;
  const mismatches = [];
  for (const row of orders.rows) {
    const recordedStep = Number(row.martingale_step);
    if (row.side !== expectedSide || recordedStep !== expectedStep) {
      mismatches.push({
        ticker: row.ticker,
        recordedSide: row.side,
        recordedStep,
        expectedSide,
        expectedStep,
        result: row.settlement_result,
      });
    }
    const won = row.settlement_result === row.side;
    if (won) {
      expectedSide = row.side === "yes" ? "no" : "yes";
      expectedStep = 0;
    } else {
      expectedSide = row.side;
      expectedStep = expectedStep >= 5 ? 0 : expectedStep + 1;
    }
  }

  if (state.side !== expectedSide || Number(state.martingale_step) !== expectedStep) {
    throw new Error(`Canonical repair verification failed: state=${state.side}/${state.martingale_step}, expected=${expectedSide}/${expectedStep}`);
  }

  console.log(JSON.stringify({
    regularSequenceGuard: "installed",
    easternDate: state.eastern_date,
    canonicalSide: state.side,
    canonicalStep: Number(state.martingale_step),
    settledFilledOrdersReplayed: orders.rowCount,
    historicalSequenceMismatches: mismatches.length,
    recentMismatches: mismatches.slice(-8),
  }));
} catch (err) {
  try { await client.query("ROLLBACK"); } catch {}
  throw err;
} finally {
  await client.end();
}
