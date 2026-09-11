import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "../../../lib/db/node_modules/pg/lib/index.js";

// One-shot read-only diagnostic for the Sep 9 B Jump trade. This performs only
// SELECTs and never mutates trading state or the database.
const diagnosticTicker = "KXETH15M-26SEP091830-30";
const connectionString = process.env.DATABASE_URL;
if (connectionString) {
  const { Client } = pg;
  const client = new Client({ connectionString });
  try {
    await client.connect();
    const result = await client.query(
      `SELECT * FROM eth_big_bet_orders WHERE ticker=$1 ORDER BY created_at_ms ASC`,
      [diagnosticTicker],
    );
    console.log(JSON.stringify({
      diagnostic: "eth_big_bet_order_read_only",
      ticker: diagnosticTicker,
      rowCount: result.rowCount,
      rows: result.rows,
    }));
  } catch (error) {
    console.error(JSON.stringify({
      diagnostic: "eth_big_bet_order_read_only_failed",
      ticker: diagnosticTicker,
      error: error instanceof Error ? error.message : String(error),
    }));
  } finally {
    try { await client.end(); } catch {}
  }
}

// The published runner owns only the live ETH martingale API. Research workers
// are intentionally excluded so they cannot add load or revive retired paths.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const api = spawn(
  process.execPath,
  ["--enable-source-maps", "artifacts/api-server/dist/index.mjs"],
  { cwd: root, stdio: "inherit", env: process.env },
);
const stop = () => api.kill("SIGTERM");
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
api.on("exit", (code) => process.exit(code ?? 1));