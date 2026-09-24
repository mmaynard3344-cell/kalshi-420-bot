import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outdir = "/tmp/ts-a2-baseline-reversion";

await build({
  entryPoints:[
    path.join(root,"src/lib/strategies/a2BaselineReversion.test.ts"),
    path.join(root,"src/lib/strategies/a2BaselineReversionShadow.test.ts"),
  ],
  platform:"node",
  bundle:true,
  format:"esm",
  outdir,
  outExtension:{".js":".mjs"},
  logLevel:"warning",
});

const files = [
  path.join(outdir,"a2BaselineReversion.test.mjs"),
  path.join(outdir,"a2BaselineReversionShadow.test.mjs"),
];
const run=spawnSync(process.execPath,["--test",...files],{stdio:"inherit",cwd:root});
process.exit(run.status??1);
