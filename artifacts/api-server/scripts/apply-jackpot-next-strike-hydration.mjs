import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const researchPath = join(here, "..", "src", "lib", "strategies", "jackpotPreboundaryResearch.ts");
let source = readFileSync(researchPath, "utf8");

const from = `      const exact = selectExactBoundaryMarket(data.markets ?? [], boundaryMs);\n      if (exact) return exact;`;
const to = `      const exact = selectExactBoundaryMarket(data.markets ?? [], boundaryMs);\n      if (exact) {\n        const ticker = typeof exact["ticker"] === "string" ? exact["ticker"] : null;\n        if (!ticker) return null;\n        // The /markets catalog can expose the exact next ticker before it includes\n        // floor_strike. Hydrate that exact ticker from the market-detail endpoint\n        // so J has the authoritative strike without guessing or substituting a row.\n        try {\n          const detail = await kalshiFetch<{ market?: Record<string, unknown> }>(\n            \`/markets/\${encodeURIComponent(ticker)}\`,\n          );\n          const hydrated = detail.market ?? (detail as Record<string, unknown>);\n          const hydratedTicker = typeof hydrated["ticker"] === "string" ? hydrated["ticker"] : null;\n          if (hydratedTicker === ticker) return { ...exact, ...hydrated };\n        } catch {\n          // Fall through to the catalog row. marketSnapshot will fail closed if\n          // Kalshi still has not published a strike for this exact ticker.\n        }\n        return exact;\n      }`;

const hits = source.split(from).length - 1;
if (hits === 0 && source.includes('const detail = await kalshiFetch<{ market?: Record<string, unknown> }>(')) {
  console.log("Jackpot next-strike hydration already applied");
  process.exit(0);
}
if (hits !== 1) {
  throw new Error(`Jackpot next-strike hydration expected one exact-market return anchor, found ${hits}`);
}

source = source.replace(from, to);
if (!source.includes('/markets/${encodeURIComponent(ticker)}')) {
  throw new Error("Jackpot next-strike hydration refused build: detail endpoint was not installed");
}
writeFileSync(researchPath, source);
console.log("Applied Jackpot next-strike hydration via exact market-detail lookup");
