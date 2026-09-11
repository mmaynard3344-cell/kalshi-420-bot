import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.resolve(here, "../src/lib/kalshiStream.ts");
let source = await readFile(target, "utf8");

const before = `    "subtitle",\n    "event_ticker",\n    "exchange_index",`;
const after = `    "subtitle",\n    "event_ticker",\n    "status",\n    "exchange_index",`;
const count = source.split(before).length - 1;
if (count !== 1) throw new Error(`Kalshi stream status backfill patch: expected one fill-field anchor, found ${count}`);
source = source.replace(before, after);

const backfillBefore = `                if (normalized[field] == null && snapshot[field] != null) {\n                  normalized[field] = snapshot[field];\n                }`;
const backfillAfter = `                const missingFromWs = normalized[field] == null || (field === "status" && normalized[field] === "unknown");\n                if (missingFromWs && snapshot[field] != null) {\n                  normalized[field] = snapshot[field];\n                }`;
const backfillCount = source.split(backfillBefore).length - 1;
if (backfillCount !== 1) throw new Error(`Kalshi stream status backfill patch: expected one backfill loop, found ${backfillCount}`);
source = source.replace(backfillBefore, backfillAfter);

await writeFile(target, source, "utf8");
console.log("Kalshi stream status backfill applied: WS ticker state inherits REST market status");
