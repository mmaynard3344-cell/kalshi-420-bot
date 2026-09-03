/**
 * Build and run all three ETH30 unit test suites with esbuild-plugin-pino so
 * pino's CJS dynamic-require works inside an ESM bundle.
 *
 * Covers:
 *   - src/lib/strategies/eth30_50.test.ts
 *   - src/lib/strategies/eth30FillSync.test.ts
 *   - src/lib/strategies/eth30Report.test.ts
 *
 * These are pure in-memory unit tests — no DATABASE_URL needed.
 */

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import esbuildPluginPino from "esbuild-plugin-pino";

globalThis.require = createRequire(import.meta.url);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root      = path.resolve(__dirname, "..");

const BANNER = `import { createRequire as __bannerCrReq } from 'node:module';
import __bannerPath from 'node:path';
import { fileURLToPath as __bannerFtu } from 'node:url';
const require = __bannerCrReq(__bannerFtu(import.meta.url));
const __filename = __bannerFtu(import.meta.url);
const __dirname = __bannerPath.dirname(__filename);`;

const suites = [
  { src: "src/lib/strategies/eth30_50.test.ts",       out: "/tmp/ts-eth30-main/eth30_50.test.mjs" },
  { src: "src/lib/strategies/eth30ShadowTelemetry.test.ts", out: "/tmp/ts-eth30-shadow/eth30ShadowTelemetry.test.mjs" },
  { src: "src/lib/strategies/pairedSideShadow.test.ts", out: "/tmp/ts-eth30-paired-side/pairedSideShadow.test.mjs" },
  { src: "src/lib/strategies/eth30FillSync.test.ts",  out: "/tmp/ts-eth30-fillsync/eth30FillSync.test.mjs" },
  { src: "src/lib/strategies/eth30Report.test.ts",    out: "/tmp/ts-eth30-report/eth30Report.test.mjs" },
];

let overallExit = 0;

for (const { src, out } of suites) {
  const outdir  = path.dirname(out);
  const outfile = out;

  await build({
    entryPoints: [path.join(root, src)],
    platform:    "node",
    bundle:      true,
    format:      "esm",
    outdir,
    outExtension: { ".js": ".mjs" },
    logLevel:    "warning",
    banner:      { js: BANNER },
    plugins:     [esbuildPluginPino({ transports: ["pino-pretty"] })],
  }).catch((err) => { console.error(err); process.exit(1); });

  const proc = spawnSync(process.execPath, ["--test", outfile], {
    stdio: "inherit",
    cwd:   root,
  });

  if ((proc.status ?? 1) !== 0) overallExit = 1;
}

process.exit(overallExit);
