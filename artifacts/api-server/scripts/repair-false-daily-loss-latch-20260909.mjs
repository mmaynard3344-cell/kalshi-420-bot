import pg from "../../../lib/db/node_modules/pg/lib/index.js";
const { Client } = pg;
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for false daily-loss latch repair");

const REPAIR_DATE = "2026-09-09";
const REPAIR_CUTOFF_MS = 1788974100000; // 2026-09-09 17:15:00 UTC; only pre-fix latches are eligible.
const THRESHOLD_CENTS = -120000;

const client = new Client({ connectionString });
await client.connect();
try {
  await client.query("BEGIN");
  const day = (await client.query(`SELECT to_char(clock_timestamp() AT TIME ZONE 'America/New_York','YYYY-MM-DD') AS d`)).rows[0].d;
  if (day !== REPAIR_DATE) {
    await client.query("COMMIT");
    console.log(JSON.stringify({falseDailyLossLatchRepair:"skipped",reason:"outside_repair_date",easternDate:day}));
    process.exit(0);
  }

  await client.query(`SELECT pg_advisory_xact_lock(hashtext('eth-account-daily-loss:'||$1))`, [day]);
  const state = await client.query(`
    SELECT
      eth_account_realized_pnl_cents($1)::bigint AS realized,
      eth_account_open_risk_cents($1)::bigint AS open_risk,
      l.triggered_realized_pnl_cents::bigint AS triggered_realized,
      l.triggered_at_ms::bigint AS triggered_at_ms
    FROM (SELECT 1) x
    LEFT JOIN eth_account_daily_loss_locks l ON l.eastern_date=$1
  `, [day]);
  const row = state.rows[0];
  const realized = Number(row.realized);
  const openRisk = Number(row.open_risk);
  const triggeredAt = row.triggered_at_ms == null ? null : Number(row.triggered_at_ms);
  const triggeredRealized = row.triggered_realized == null ? null : Number(row.triggered_realized);

  let cleared = false;
  if (
    triggeredAt != null &&
    triggeredAt < REPAIR_CUTOFF_MS &&
    triggeredRealized != null &&
    triggeredRealized <= THRESHOLD_CENTS &&
    realized > THRESHOLD_CENTS
  ) {
    const deleted = await client.query(`DELETE FROM eth_account_daily_loss_locks WHERE eastern_date=$1 AND triggered_at_ms=$2`, [day, triggeredAt]);
    cleared = deleted.rowCount === 1;
  }

  const remaining = await client.query(`SELECT EXISTS(SELECT 1 FROM eth_account_daily_loss_locks WHERE eastern_date=$1) AS latched`, [day]);
  await client.query("COMMIT");
  console.log(JSON.stringify({
    falseDailyLossLatchRepair: cleared ? "cleared" : "no_change",
    easternDate: day,
    realizedPnlCents: realized,
    openRiskCents: openRisk,
    previousTriggeredRealizedPnlCents: triggeredRealized,
    previousTriggeredAtMs: triggeredAt,
    latchedAfterRepair: Boolean(remaining.rows[0].latched),
  }));
} catch (err) {
  try { await client.query("ROLLBACK"); } catch {}
  throw err;
} finally {
  await client.end();
}
