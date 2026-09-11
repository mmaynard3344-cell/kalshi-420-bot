import pg from "../../../lib/db/node_modules/pg/lib/index.js";
const { Client } = pg;

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required to disable account daily loss guards");

const client = new Client({ connectionString });
await client.connect();
try {
  await client.query("BEGIN");
  await client.query("DROP TRIGGER IF EXISTS eth_account_daily_loss_regular_guard ON eth_martingale_orders");
  const big = await client.query("SELECT to_regclass('public.eth_big_bet_orders') AS regclass");
  if (big.rows[0]?.regclass) {
    await client.query("DROP TRIGGER IF EXISTS eth_account_daily_loss_big_bet_guard ON eth_big_bet_orders");
  }
  await client.query("COMMIT");
  console.log(JSON.stringify({ accountDailyLossGuards: "disabled", regularTrigger: "eth_account_daily_loss_regular_guard", bigBetTrigger: big.rows[0]?.regclass ? "eth_account_daily_loss_big_bet_guard" : null }));
} catch (err) {
  try { await client.query("ROLLBACK"); } catch {}
  throw err;
} finally {
  await client.end();
}
