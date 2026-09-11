import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.resolve(here, "../src/lib/strategies/ethOnlyMartingale.ts");
let source = await readFile(target, "utf8");

const currentLossStop = `    // Fail closed: loss stop\n    if (effectivePnl <= dailyLossStopCents) {\n      setEthBlockerStatus("daily_loss_stop", "ETH daily realized-loss stop is active");\n      return;\n    }\n\n`;

const projectedLossStop = `const projectedFullLossPnlCents =\n  effectivePnl - requestedPrincipalCents - reservedFeeCents;\n\nif (projectedFullLossPnlCents < dailyLossStopCents) {\n  setEthBlockerStatus(\n    "daily_loss_stop",\n    "ETH entry is blocked because a full loss on this wager would exceed the daily loss limit",\n  );\n  return;\n}\n\n`;

for (const [label, block] of [["current daily-loss stop", currentLossStop], ["projected daily-loss stop", projectedLossStop]]) {
  const count = source.split(block).length - 1;
  if (count !== 1) throw new Error(`Service A always-trade patch: expected exactly one ${label}, found ${count}`);
  source = source.replace(block, "");
}

await writeFile(target, source, "utf8");
console.log("Service A always-trade patch applied: daily-loss entry stops removed; mechanical safety gates unchanged");
