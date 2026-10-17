// Production cutover helper. Run as an explicit pre-deploy migration only after review.
// Never submits exchange orders; idempotent SQL and post-install schema validation.
import {readFile} from "node:fs/promises";
import pg from "../../../lib/db/node_modules/pg/lib/index.js";
if (process.env.ETH_G_SHARED_MIGRATION_APPROVED !== "true") {
  throw new Error("Refusing shared ETH migration without ETH_G_SHARED_MIGRATION_APPROVED=true");
}
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const sql = await readFile(new URL("../migrations/review_eth_shared_martingale.sql",import.meta.url),"utf8");
const client = new pg.Client({connectionString:process.env.DATABASE_URL});
await client.connect();
try {
  await client.query(sql);
  const tables = await client.query(
    "SELECT to_regclass('public.eth_shared_martingale_state') AS state, to_regclass('public.eth_shared_martingale_claims') AS claims"
  );
  if(!tables.rows[0]?.state||!tables.rows[0]?.claims)throw new Error("Shared ETH tables missing");
  const state=await client.query("SELECT step,active_claim_id FROM eth_shared_martingale_state WHERE singleton=TRUE");
  if(state.rowCount!==1)throw new Error("Shared ETH singleton not initialized");
  console.log("Shared ETH migration schema verified (no orders placed)");
} finally {await client.end();}
