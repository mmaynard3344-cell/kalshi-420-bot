import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.resolve(here, "../src/lib/tradeStore.ts");
let source = await readFile(target, "utf8");

const before = `        ALTER TABLE eth_martingale_orders\n          ADD COLUMN IF NOT EXISTS generation text NOT NULL DEFAULT 'legacy';\n        ALTER TABLE eth_martingale_orders\n          ADD COLUMN IF NOT EXISTS manual_settlement_override boolean NOT NULL DEFAULT false;`;

const after = `        ALTER TABLE eth_martingale_orders\n          ADD COLUMN IF NOT EXISTS generation text NOT NULL DEFAULT 'legacy';\n        -- Service A is explicitly always-trade. This legacy BEFORE INSERT trigger\n        -- predates that policy and silently returns NULL to suppress durable A\n        -- order rows after the old daily-loss threshold is reached. Remove only\n        -- this obsolete insert suppressor; all live-exposure, dedup, reservation,\n        -- balance, sequence-snapshot, and pre-POST safety fences remain intact.\n        DROP TRIGGER IF EXISTS eth_account_daily_loss_regular_guard ON eth_martingale_orders;\n        ALTER TABLE eth_martingale_orders\n          ADD COLUMN IF NOT EXISTS manual_settlement_override boolean NOT NULL DEFAULT false;`;

const count = source.split(before).length - 1;
if (count !== 1) throw new Error(`Service A daily-loss DB trigger cleanup: expected one migration anchor, found ${count}`);
source = source.replace(before, after);

await writeFile(target, source, "utf8");
console.log("Service A always-trade DB cleanup applied: obsolete daily-loss INSERT trigger will be dropped at startup");
