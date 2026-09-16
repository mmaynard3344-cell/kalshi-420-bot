import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const strategyPath = join(here, "..", "src", "lib", "strategies", "ethJackpotService.ts");
let source = readFileSync(strategyPath, "utf8");

const v1 = 'kalshiAuthFetch<Record<string, unknown>>("POST", "/portfolio/events/orders", payload)';
const v2 = 'kalshiAuthFetch<Record<string, unknown>>("POST", "/portfolio/orders", payload)';
const hits = source.split(v1).length - 1;
if (hits === 1) source = source.replace(v1, v2);
else if (hits === 0 && source.includes(v2)) {
  // Already correct; remain idempotent.
} else {
  throw new Error(`Jackpot V2 create repair expected one V1 POST anchor, found ${hits}`);
}

if (!source.includes(v2)) throw new Error("Jackpot V2 create repair failed closed: V2 POST endpoint absent");
if (source.includes(v1)) throw new Error("Jackpot V2 create repair failed closed: deprecated V1 POST endpoint remains");
writeFileSync(strategyPath, source);
console.log("Applied Jackpot-only V2 create-order endpoint repair");
