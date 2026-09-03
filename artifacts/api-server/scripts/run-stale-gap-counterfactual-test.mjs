import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const out = "/tmp/stale-gap-counterfactual.test.mjs";

try {
  execFileSync(
    join(root, "node_modules", ".bin", "esbuild"),
    [
      join(root, "src", "lib", "staleGapCounterfactual.test.ts"),
      "--bundle",
      "--platform=node",
      "--format=esm",
      `--outfile=${out}`,
    ],
    { stdio: "inherit" },
  );
  execFileSync(process.execPath, ["--test", out], { stdio: "inherit" });
} finally {
  rmSync(out, { force: true });
}