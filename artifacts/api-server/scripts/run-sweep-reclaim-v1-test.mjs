import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outdir = "/tmp/ts-sweep-reclaim-v1";
const outfile = path.join(outdir, "sweepReclaimV1.test.mjs");
await build({
  entryPoints: [path.join(root, "src/lib/strategies/sweepReclaimV1.test.ts")],
  platform: "node",
  bundle: true,
  format: "esm",
  outdir,
  outExtension: { ".js": ".mjs" },
  logLevel: "warning",
});
const run = spawnSync(process.execPath, ["--test", outfile], { stdio: "inherit", cwd: root });
process.exit(run.status ?? 1);
