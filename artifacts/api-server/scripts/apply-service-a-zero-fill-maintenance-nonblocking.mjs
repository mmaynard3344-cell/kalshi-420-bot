import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.resolve(here, "../src/lib/strategies/ethOnlyMartingale.ts");
let source = await readFile(target, "utf8");

const before = `export async function reconcileEthMartingaleZeroFillLadders(): Promise<boolean> {\n  const zeroFills = await ethDependencies.store.listUnsettledEthMartingaleZeroFillOrders();\n  if (!zeroFills) {\n    scheduleEthDurableRetry("durable_store_failure");\n    return false;\n  }`;

const after = `export async function reconcileEthMartingaleZeroFillLadders(): Promise<boolean> {\n  const zeroFills = await ethDependencies.store.listUnsettledEthMartingaleZeroFillOrders();\n  if (!zeroFills) {\n    // A zero-fill settlement queue is historical sequence/accounting maintenance,\n    // not proof of live Kalshi exposure. Keep that maintenance retrying, but\n    // independently require the authoritative unsettled-order ledger to prove\n    // there is no pending/resting/partial/ambiguous Service A order before a\n    // fresh window can proceed. If the live ledger is unavailable, fail closed.\n    scheduleEthDurableRetry(\n      "durable_store_failure",\n      null,\n      "zero-fill settlement maintenance queue unavailable",\n    );\n    const liveExposure = await ethDependencies.store.listUnsettledEthMartingaleOrders();\n    if (liveExposure == null || liveExposure.length > 0) return false;\n    setEthBlockerStatus(\n      "ready",\n      "No unresolved ETH martingale exposure; zero-fill settlement maintenance will retry in background",\n    );\n    return true;\n  }`;

const count = source.split(before).length - 1;
if (count !== 1) {
  throw new Error(`Service A zero-fill maintenance patch: expected one anchor, found ${count}`);
}

source = source.replace(before, after);
await writeFile(target, source, "utf8");
console.log("Service A zero-fill maintenance isolation applied: historical zero-fill queue failures no longer block a proven-clean live ledger");
