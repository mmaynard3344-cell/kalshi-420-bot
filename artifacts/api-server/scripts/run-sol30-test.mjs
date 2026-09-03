/**
 * Build and run all SOL_30_50 unit test suites with esbuild-plugin-pino so
 * pino's CJS dynamic-require works inside an ESM bundle.
 *
 * Covers:
 *   - src/lib/strategies/sol30_50.test.ts
 *   - src/lib/strategies/sol30FillSync.test.ts
 *   - src/lib/strategies/sol30Report.test.ts
 *   - src/lib/tradeStore.sol30.test.ts
 *
 * These are pure in-memory unit tests — no DATABASE_URL needed for the first
 * three; tradeStore.sol30.test.ts uses the real dev database.
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
  { src: "src/lib/strategies/sol30_50.test.ts",      out: "/tmp/ts-sol30-main/sol30_50.test.mjs" },
  { src: "src/lib/strategies/sol30FillSync.test.ts", out: "/tmp/ts-sol30-fillsync/sol30FillSync.test.mjs" },
  { src: "src/lib/strategies/sol30Report.test.ts",   out: "/tmp/ts-sol30-report/sol30Report.test.mjs" },
  { src: "src/lib/tradeStore.sol30.test.ts",         out: "/tmp/ts-sol30-tradestore/tradeStore.sol30.test.mjs" },
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
