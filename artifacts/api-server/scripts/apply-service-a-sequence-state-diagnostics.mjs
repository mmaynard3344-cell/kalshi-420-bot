import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.resolve(here, "../src/lib/tradeStore.ts");
let source = await readFile(target, "utf8");

const stateBefore = `export async function getEthMartingaleState(): Promise<EthMartingaleState | null> {\n  if (!_db || !_healthy) return null;\n  try {\n    const result = await _db.execute(sql\`\n      SELECT eastern_date, side, martingale_step, spent_cents, realized_pnl_cents\n      FROM eth_martingale_state WHERE strategy_key = \${ETH_MARTINGALE_ACTIVE_GENERATION_KEY}\`);\n    const row = (result as unknown as { rows: Array<Record<string, unknown>> }).rows[0];\n    return row ? {`;

const stateAfter = `export async function getEthMartingaleState(): Promise<EthMartingaleState | null> {\n  if (!_db || !_healthy) {\n    logger.warn({ dbPresent: _db != null, storageHealthy: _healthy, strategyKey: ETH_MARTINGALE_ACTIVE_GENERATION_KEY },\n      \"eth: executable martingale state unavailable before query\");\n    return null;\n  }\n  try {\n    const result = await _db.execute(sql\`\n      SELECT eastern_date, side, martingale_step, spent_cents, realized_pnl_cents\n      FROM eth_martingale_state WHERE strategy_key = \${ETH_MARTINGALE_ACTIVE_GENERATION_KEY}\`);\n    const row = (result as unknown as { rows: Array<Record<string, unknown>> }).rows[0];\n    if (!row) {\n      logger.error({ strategyKey: ETH_MARTINGALE_ACTIVE_GENERATION_KEY },\n        \"eth: executable martingale state row missing\");\n    }\n    return row ? {`;

const stateCount = source.split(stateBefore).length - 1;
if (stateCount !== 1) throw new Error(`Service A diagnostics: expected one state-read anchor, found ${stateCount}`);
source = source.replace(stateBefore, stateAfter);

const exposureBefore = `export async function listUnsettledEthMartingaleOrders(): Promise<EthMartingaleOrder[] | null> {\n  if (!_db || !_healthy) {\n    recordDbBlockedOperation(\"reconciliation\");\n    return null;\n  }`;
const exposureAfter = `export async function listUnsettledEthMartingaleOrders(): Promise<EthMartingaleOrder[] | null> {\n  if (!_db || !_healthy) {\n    logger.warn({\n      dbPresent: _db != null,\n      storageHealthy: _healthy,\n      lastError: _lastErrorMsg,\n      degradedReason: _degradedReason,\n      strategyKey: ETH_MARTINGALE_ACTIVE_GENERATION_KEY,\n    }, \"eth: authoritative unsettled ledger unavailable before query\");\n    recordDbBlockedOperation(\"reconciliation\");\n    return null;\n  }`;
const exposureCount = source.split(exposureBefore).length - 1;
if (exposureCount !== 1) throw new Error(`Service A diagnostics: expected one unsettled-ledger gate, found ${exposureCount}`);
source = source.replace(exposureBefore, exposureAfter);

const postBefore = `export async function markEthMartingaleOrderPostStarted(id: string): Promise<boolean> {\n  if (!_db || !_healthy) return false;\n  try {\n    const result = await _db.execute(sql\`\n      UPDATE eth_martingale_orders SET outcome = 'post_started', updated_at_ms = \${Date.now()}\n      WHERE id = \${id} AND generation = \${ETH_MARTINGALE_ACTIVE_GENERATION_KEY}\n        AND created_at_ms >= \${ETH_MARTINGALE_ACTIVE_GENERATION_STARTED_AT_MS}\n        AND outcome = 'pending' AND kalshi_order_id IS NULL AND filled_contracts IS NULL\n      RETURNING id\`);\n    return (result as unknown as { rows: unknown[] }).rows.length === 1;\n  } catch (err) {\n    logger.warn({ err, id }, \"eth: unable to record POST start; submission blocked\");\n    return false;\n  }\n}`;
const postAfter = `export async function markEthMartingaleOrderPostStarted(id: string): Promise<boolean> {\n  if (!_db || !_healthy) {\n    logger.warn({ id, dbPresent: _db != null, storageHealthy: _healthy, lastError: _lastErrorMsg, degradedReason: _degradedReason },\n      \"eth: POST-start fence unavailable before query\");\n    return false;\n  }\n  try {\n    const result = await _db.execute(sql\`\n      UPDATE eth_martingale_orders SET outcome = 'post_started', updated_at_ms = \${Date.now()}\n      WHERE id = \${id} AND generation = \${ETH_MARTINGALE_ACTIVE_GENERATION_KEY}\n        AND created_at_ms >= \${ETH_MARTINGALE_ACTIVE_GENERATION_STARTED_AT_MS}\n        AND outcome = 'pending' AND kalshi_order_id IS NULL AND filled_contracts IS NULL\n      RETURNING id\`);\n    if ((result as unknown as { rows: unknown[] }).rows.length === 1) return true;\n    try {\n      const diagnostic = await _db.execute(sql\`\n        SELECT id, generation, outcome, created_at_ms,\n               kalshi_order_id IS NOT NULL AS has_kalshi_order_id,\n               filled_contracts\n        FROM eth_martingale_orders\n        WHERE id = \${id}\n        LIMIT 1\`);\n      const row = (diagnostic as unknown as { rows: Array<Record<string, unknown>> }).rows[0] ?? null;\n      logger.warn({ id, row, activeGeneration: ETH_MARTINGALE_ACTIVE_GENERATION_KEY, generationStartMs: ETH_MARTINGALE_ACTIVE_GENERATION_STARTED_AT_MS },\n        \"eth: POST-start fence matched zero rows\");\n    } catch (diagnosticErr) {\n      logger.warn({ id, diagnosticErr }, \"eth: POST-start zero-row diagnostic read failed\");\n    }\n    return false;\n  } catch (err) {\n    logger.warn({ err, id }, \"eth: unable to record POST start; submission blocked\");\n    return false;\n  }\n}`;
const postCount = source.split(postBefore).length - 1;
if (postCount !== 1) throw new Error(`Service A diagnostics: expected one POST-start fence anchor, found ${postCount}`);
source = source.replace(postBefore, postAfter);

await writeFile(target, source, "utf8");
console.log("Service A diagnostics applied: sequence state, live ledger health, and pre-POST fence failures are now distinct");
