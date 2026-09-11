import pg from "../../../lib/db/node_modules/pg/lib/index.js";
const { Client } = pg;

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required to disable Service A daily loss guard");

const client = new Client({ connectionString });
await client.connect();
try {
  await client.query("BEGIN");
  await client.query("DROP TRIGGER IF EXISTS eth_account_daily_loss_regular_guard ON eth_martingale_orders");
  await client.query("COMMIT");
  console.log(JSON.stringify({ serviceADailyLossGuard: "disabled", trigger: "eth_account_daily_loss_regular_guard" }));
} catch (err) {
  try { await client.query("ROLLBACK"); } catch {}
  throw err;
} finally {
  await client.end();
}
