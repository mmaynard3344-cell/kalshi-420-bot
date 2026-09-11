import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.resolve(here, "../src/lib/strategies/ethOnlyMartingale.ts");
let source = await readFile(target, "utf8");

const redundantBefore = `    // Resolve any accepted-or-ambiguous prior GTC first; if unresolved, block new entries.\n    if (!await reconcileEthMartingaleSettlements()) return;\n    const unsettled = await ethDependencies.store.listUnsettledEthMartingaleOrders();\n    // A failed list is never equivalent to an empty list: a transient database\n    // timeout must not make a potentially live prior GTC invisible.\n    // A terminal fill remains fenced until exact fill economics and settlement\n    // have durably advanced (or preserved) the sequence. A zero-fill awaiting\n    // its official result is excluded from this exposure list and must not\n    // block a fresh window; a later sweep advances its sequence when the\n    // result posts.\n    if (unsettled == null) {\n      scheduleEthDurableRetry("durable_store_failure");\n      return;\n    }\n    if (unsettled.length > 0) return;`;

const redundantAfter = `    // Resolve any accepted-or-ambiguous prior GTC first; if unresolved, block new entries.\n    // A successful reconciliation now includes the authoritative live-exposure proof,\n    // so do not immediately repeat the same bounded ledger read and re-block a clean window.\n    if (!await reconcileEthMartingaleSettlements()) return;`;

const redundantCount = source.split(redundantBefore).length - 1;
if (redundantCount !== 1) throw new Error(`Service A exposure-proof patch: expected one preflight anchor, found ${redundantCount}`);
source = source.replace(redundantBefore, redundantAfter);

const terminalBefore = `  }\n  return true;\n}\n\n/**\n * A regular zero-fill order has no fill economics or P&L, but is still one`;
const terminalAfter = `  }\n  // A true reconciliation result is also the live-entry exposure proof. Re-read once\n  // after a sweep that began with unresolved rows because the in-memory row objects\n  // may be stale after durable terminal transitions. Never let true mean "still exposed".\n  const remainingExposure = await ethDependencies.store.listUnsettledEthMartingaleOrders();\n  if (remainingExposure == null) {\n    scheduleEthDurableRetry("durable_store_failure", null, "final live exposure read unavailable");\n    return false;\n  }\n  if (remainingExposure.length > 0) return false;\n  clearEthDurableRetry();\n  setEthBlockerStatus("ready", "No unresolved ETH martingale exposure");\n  return true;\n}\n\n/**\n * A regular zero-fill order has no fill economics or P&L, but is still one`;

const terminalCount = source.split(terminalBefore).length - 1;
if (terminalCount !== 1) throw new Error(`Service A exposure-proof patch: expected one reconciliation tail anchor, found ${terminalCount}`);
source = source.replace(terminalBefore, terminalAfter);

await writeFile(target, source, "utf8");
console.log("Service A single exposure proof applied: reconciliation true now guarantees no live exposure and preflight does not repeat the same ledger read");
