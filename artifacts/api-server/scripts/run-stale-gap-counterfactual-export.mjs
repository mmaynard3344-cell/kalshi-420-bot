import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const out = join(root, "scripts", ".export-stale-gap-counterfactuals.mjs");
try {
  execFileSync(join(root, "node_modules", ".bin", "esbuild"), [
    join(root, "scripts/export-stale-gap-counterfactuals.ts"),
    "--bundle", "--platform=node", "--format=esm", "--packages=external", `--outfile=${out}`,
  ], { stdio: "inherit" });
  execFileSync(process.execPath, [out, ...process.argv.slice(2)], { stdio: "inherit" });
} finally {
  rmSync(out, { force: true });
}