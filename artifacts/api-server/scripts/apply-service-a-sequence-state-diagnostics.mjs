import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.resolve(here, "../src/lib/tradeStore.ts");
let source = await readFile(target, "utf8");

const before = `export async function getEthMartingaleState(): Promise<EthMartingaleState | null> {\n  if (!_db || !_healthy) return null;\n  try {\n    const result = await _db.execute(sql\`\n      SELECT eastern_date, side, martingale_step, spent_cents, realized_pnl_cents\n      FROM eth_martingale_state WHERE strategy_key = \${ETH_MARTINGALE_ACTIVE_GENERATION_KEY}\`);\n    const row = (result as unknown as { rows: Array<Record<string, unknown>> }).rows[0];\n    return row ? {`;

const after = `export async function getEthMartingaleState(): Promise<EthMartingaleState | null> {\n  if (!_db || !_healthy) {\n    logger.warn({ dbPresent: _db != null, storageHealthy: _healthy, strategyKey: ETH_MARTINGALE_ACTIVE_GENERATION_KEY },\n      \"eth: executable martingale state unavailable before query\");\n    return null;\n  }\n  try {\n    const result = await _db.execute(sql\`\n      SELECT eastern_date, side, martingale_step, spent_cents, realized_pnl_cents\n      FROM eth_martingale_state WHERE strategy_key = \${ETH_MARTINGALE_ACTIVE_GENERATION_KEY}\`);\n    const row = (result as unknown as { rows: Array<Record<string, unknown>> }).rows[0];\n    if (!row) {\n      logger.error({ strategyKey: ETH_MARTINGALE_ACTIVE_GENERATION_KEY },\n        \"eth: executable martingale state row missing\");\n      return null;\n    }\n    return {`;

const count = source.split(before).length - 1;
if (count !== 1) throw new Error(`Service A sequence-state diagnostics: expected one state-read anchor, found ${count}`);
source = source.replace(before, after);

const catchBefore = `      realizedPnlCents: Number(row[\"realized_pnl_cents\"] ?? 0),\n    } : null;\n  } catch (err) {\n    logger.warn({ err }, \"eth martingale state read failed\");\n    return null;\n  }\n}`;
const catchAfter = `      realizedPnlCents: Number(row[\"realized_pnl_cents\"] ?? 0),\n    };\n  } catch (err) {\n    logger.error({ err, strategyKey: ETH_MARTINGALE_ACTIVE_GENERATION_KEY },\n      \"eth: executable martingale state query failed\");\n    return null;\n  }\n}`;

const catchCount = source.split(catchBefore).length - 1;
if (catchCount !== 1) throw new Error(`Service A sequence-state diagnostics: expected one state-read catch anchor, found ${catchCount}`);
source = source.replace(catchBefore, catchAfter);

await writeFile(target, source, "utf8");
console.log("Service A sequence-state diagnostics applied: unavailable, missing-row, and SQL-error causes are now distinct");
