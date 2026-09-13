import { build } from "esbuild";
import { rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

const entry = path.resolve("artifacts/api-server/scripts/eth-big-bet-readonly-diagnostic.ts");
const outfile = "/tmp/eth-big-bet-readonly-diagnostic.cjs";

try {
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    sourcemap: false,
    logLevel: "silent",
    external: ["pg-native"],
  });
  const run = spawnSync(process.execPath, [outfile], { stdio: "inherit", env: process.env });
  if (run.error) throw run.error;
  if (run.status !== 0) process.exitCode = run.status ?? 1;
} finally {
  await rm(outfile, { force: true });
}
