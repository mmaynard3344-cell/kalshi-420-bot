import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const suites = ["tMinusSevenExit.test.ts", "target75ExitStore.test.ts"];
let failed = false;
for (const suite of suites) {
  const outfile = "/tmp/shawshank-target75-test/" + suite.replace(".ts", ".mjs");
  await build({
    entryPoints: [path.join(root, "src/lib", suite)],
    platform: "node", bundle: true, format: "esm", outfile, logLevel: "warning",
  });
  const result = spawnSync(process.execPath, ["--test", outfile], { stdio: "inherit", cwd: root });
  if ((result.status ?? 1) !== 0) failed = true;
}
process.exit(failed ? 1 : 0);
