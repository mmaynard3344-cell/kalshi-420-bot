import { createRequire } from "node:module";
const require = createRequire(new URL("../../../lib/db/package.json", import.meta.url));
const { Client } = require("pg");
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  await client.query("BEGIN READ ONLY");
  await client.query(`SELECT id,strategy_id,source_candle_open_ms,destination_ticker,lifecycle_state,
    client_order_id,kalshi_order_id,filled_contracts,average_fill_price_cents,actual_fee_cents,
    settlement_result,realized_pnl_cents FROM sweep_reclaim_claims LIMIT 0`);
  await client.query(`SELECT id,bucket,service,source_order_id,client_order_id,exchange_index,
    requested_risk_cents,active_risk_cents,state FROM eth_long_reversal_reservations LIMIT 0`);
  const indexes = await client.query(`SELECT indexname FROM pg_indexes WHERE schemaname='public'
    AND indexname IN ('sweep_reclaim_claim_identity_uq','eth_long_reversal_client_order_uq')`);
  if (indexes.rows.length !== 2) throw new Error("L permanent claim/reservation unique indexes are missing");
  await client.query("ROLLBACK");
  console.log("L live schema read-only verification passed");
} finally { await client.end(); }
