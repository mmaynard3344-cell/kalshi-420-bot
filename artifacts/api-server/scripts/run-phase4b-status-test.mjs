import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { build } from "esbuild";
import esbuildPluginPino from "esbuild-plugin-pino";

globalThis.require = createRequire(import.meta.url);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outdir = "/tmp/phase4b-status-test";
const outfile = path.join(outdir, "trade.phase4bCaptureStatus.test.js");

await rm(outdir, { recursive: true, force: true });
try {
  await build({
    entryPoints: [path.join(root, "src/routes/trade.phase4bCaptureStatus.test.ts")],
    platform: "node",
    bundle: true,
    format: "esm",
    outdir,
    logLevel: "warning",
    banner: {
      js: `import { createRequire as __bannerCrReq } from 'node:module';
const require = __bannerCrReq(import.meta.url);`,
    },
    plugins: [esbuildPluginPino({ transports: ["pino-pretty"] })],
  });
  const result = spawnSync(process.execPath, ["--test", outfile], {
    cwd: root,
    stdio: "inherit",
  });
  process.exitCode = result.status ?? 1;
} finally {
  await rm(outdir, { recursive: true, force: true });
}