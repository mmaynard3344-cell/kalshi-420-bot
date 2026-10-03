import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
await build({ entryPoints: [path.join(root, "artifacts/api-server/src/lib/strategies/btcJumpSignal.ts")],
  bundle: true, platform: "node", format: "esm", outfile: path.join(root, "artifacts/btc-shadow/btcJumpSignal.mjs") });
