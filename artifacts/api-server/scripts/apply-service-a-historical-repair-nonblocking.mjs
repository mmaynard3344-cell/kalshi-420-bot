import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.resolve(here, "../src/lib/strategies/ethOnlyMartingale.ts");
let source = await readFile(target, "utf8");

const queueBefore = `  const economicsQueue = await ethDependencies.store.listEthMartingaleOrdersNeedingFillEconomics();\n  if (economicsQueue == null) {\n    scheduleEthDurableRetry("durable_store_failure");\n    return false;\n  }`;

const queueAfter = `  const economicsQueue = await ethDependencies.store.listEthMartingaleOrdersNeedingFillEconomics();\n  if (economicsQueue == null) {\n    // Historical fill-economics maintenance must never be mistaken for live exposure.\n    // Keep its bounded retry scheduled, but independently prove the live ledger is clean.\n    scheduleEthDurableRetry("durable_store_failure", null, "historical fill-economics queue unavailable");\n    const liveExposure = await ethDependencies.store.listUnsettledEthMartingaleOrders();\n    if (liveExposure == null || liveExposure.length > 0) return false;\n    setEthBlockerStatus(\n      "ready",\n      "No unresolved ETH martingale exposure; historical fill-economics maintenance will retry in background",\n    );\n    return true;\n  }`;

const queueCount = source.split(queueBefore).length - 1;
if (queueCount !== 1) throw new Error(`Service A historical repair patch: expected one queue anchor, found ${queueCount}`);
source = source.replace(queueBefore, queueAfter);

const settledBefore = `  if (unsettledOrders.length === 0) {\n    // A settled historical row can still require a durable exact-economics\n    // repair. Keep its bounded retry alive even though no live exposure remains.\n    if (durableEconomicsRepairPending) return false;\n    clearEthDurableRetry();\n    setEthBlockerStatus("ready", "No unresolved ETH martingale exposure");\n    return true;\n  }`;

const settledAfter = `  if (unsettledOrders.length === 0) {\n    // A settled historical row can still require exact-economics maintenance, but\n    // it is not live exposure. Preserve the scheduled repair retry without blocking\n    // a new Service A window after the authoritative unsettled ledger proved empty.\n    if (durableEconomicsRepairPending) {\n      setEthBlockerStatus(\n        "ready",\n        "No unresolved ETH martingale exposure; settled historical fill-economics repair will retry in background",\n      );\n      return true;\n    }\n    clearEthDurableRetry();\n    setEthBlockerStatus("ready", "No unresolved ETH martingale exposure");\n    return true;\n  }`;

const settledCount = source.split(settledBefore).length - 1;
if (settledCount !== 1) throw new Error(`Service A historical repair patch: expected one settled-row anchor, found ${settledCount}`);
source = source.replace(settledBefore, settledAfter);

await writeFile(target, source, "utf8");
console.log("Service A historical repair isolation applied: settled maintenance retries no longer block a proven-clean live ledger");
