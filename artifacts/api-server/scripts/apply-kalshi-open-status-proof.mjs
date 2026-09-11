import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.resolve(here, "../src/lib/kalshi.ts");
let source = await readFile(target, "utf8");

const before = `      const raw = status === "unopened"\n        ? selectNearestFutureUnopenedMarket(data.markets ?? [], Date.now())\n        : data.markets?.[0] ?? null;\n      _seriesCache.set(cacheKey, { raw, fetchedAt: Date.now() });\n      return raw;`;

const after = `      const selected = status === "unopened"\n        ? selectNearestFutureUnopenedMarket(data.markets ?? [], Date.now())\n        : data.markets?.[0] ?? null;\n      // The request itself is authoritative evidence that a returned row belongs\n      // to the open-market set. Kalshi's current response can omit the row-level\n      // status field; preserve fail-closed behavior for every other fetch mode,\n      // but carry the proven query status into this open-market snapshot.\n      const raw = selected != null && status === "open" && selected["status"] == null\n        ? { ...selected, status: "open" }\n        : selected;\n      _seriesCache.set(cacheKey, { raw, fetchedAt: Date.now() });\n      return raw;`;

const count = source.split(before).length - 1;
if (count !== 1) {
  throw new Error(`Kalshi open-status proof patch: expected one open-market selection block, found ${count}`);
}
source = source.replace(before, after);

await writeFile(target, source, "utf8");
console.log("Kalshi open-status proof applied: status=open query evidence is retained when row status is omitted");
