import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outdir = await mkdtemp(path.join(tmpdir(), "btc-jump-signal-"));
try {
  const outfile = path.join(outdir, "test.mjs");
  await build({ entryPoints: [path.join(root, "src/lib/strategies/btcJumpSignal.test.ts")],
    outfile, platform: "node", bundle: true, format: "esm", logLevel: "warning" });
  const result = spawnSync(process.execPath, ["--test", outfile], { stdio: "inherit" });
  process.exitCode = result.status ?? 1;
} finally { await rm(outdir, { recursive: true, force: true }); }
