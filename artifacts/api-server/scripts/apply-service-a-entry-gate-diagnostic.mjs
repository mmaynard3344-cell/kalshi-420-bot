import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.resolve(here, "../src/lib/strategies/ethOnlyMartingale.ts");
let source = await readFile(target, "utf8");

const eligibility = `  if (!isEthMarketEligible(state.status, state.openTime, state.closeTime, ethDependencies.now())) return;`;
const eligibilityReplacement = `  if (!isEthMarketEligible(state.status, state.openTime, state.closeTime, ethDependencies.now())) {\n    logger.info({ ticker: state.ticker, status: state.status, openTime: state.openTime, closeTime: state.closeTime, exchangeIndex: state.exchangeIndex ?? null, nowMs: ethDependencies.now() }, \"ETH Service A entry gate: market ineligible\");\n    return;\n  }`;

const reconcile = `    if (!await reconcileEthMartingaleSettlements()) return;`;
const reconcileReplacement = `    if (!await reconcileEthMartingaleSettlements()) {\n      logger.info({ ticker: state.ticker }, \"ETH Service A entry gate: settlement reconciliation incomplete\");\n      return;\n    }`;

const unsettled = `    if (unsettled.length > 0) return;`;
const unsettledReplacement = `    if (unsettled.length > 0) {\n      logger.info({ ticker: state.ticker, unsettled: unsettled.map((row) => ({ ticker: row.ticker, outcome: row.outcome, orderId: row.kalshiOrderId ?? null, filledContracts: row.filledContracts, requestedContracts: row.requestedContracts })) }, \"ETH Service A entry gate: unsettled martingale order blocks new window\");\n      return;\n    }`;

for (const [label, before, after] of [
  ["market eligibility gate", eligibility, eligibilityReplacement],
  ["settlement reconciliation gate", reconcile, reconcileReplacement],
  ["unsettled order gate", unsettled, unsettledReplacement],
]) {
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`Service A entry diagnostic: expected exactly one ${label}, found ${count}`);
  source = source.replace(before, after);
}

await writeFile(target, source, "utf8");
console.log("Service A entry-gate diagnostics applied");
