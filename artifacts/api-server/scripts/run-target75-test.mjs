import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outfile = "/tmp/shawshank-target75-test/target75.test.mjs";
await build({
  entryPoints: [path.join(root, "src/lib/tMinusSevenExit.test.ts")],
  platform: "node",
  bundle: true,
  format: "esm",
  outfile,
  logLevel: "warning",
});
const result = spawnSync(process.execPath, ["--test", outfile], { stdio: "inherit", cwd: root });
process.exit(result.status ?? 1);
