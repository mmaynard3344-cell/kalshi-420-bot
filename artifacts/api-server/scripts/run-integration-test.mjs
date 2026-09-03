/**
 * Build and run the autoTrader integration tests with the same esbuild
 * configuration as the tradeStore SQL tests (esbuild-plugin-pino for
 * CJS/ESM pino compatibility), then fork a child process to run them.
 *
 * These tests exercise the full evaluate() → checkAndPlace() → placeOrder()
 * path with injectable mock deps. No live DB or Kalshi API required.
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

const outdir  = "/tmp/ts-integration";
const outfile = path.join(outdir, "autoTrader.integration.test.mjs");

const result = await build({
  entryPoints: [path.join(root, "src/lib/autoTrader.integration.test.ts")],
  platform:    "node",
  bundle:      true,
  format:      "esm",
  outdir,
  outExtension: { ".js": ".mjs" },
  logLevel:    "warning",
  banner: {
    js: `import { createRequire as __bannerCrReq } from 'node:module';
import __bannerPath from 'node:path';
import { fileURLToPath as __bannerFtu } from 'node:url';
const require = __bannerCrReq(__bannerFtu(import.meta.url));
const __filename = __bannerFtu(import.meta.url);
const __dirname = __bannerPath.dirname(__filename);`,
  },
  plugins: [esbuildPluginPino({ transports: ["pino-pretty"] })],
}).catch((err) => { console.error(err); process.exit(1); });

void result;

const proc = spawnSync(process.execPath, ["--test", outfile], {
  stdio: "inherit",
  // Research-only captures derive their data path from process.cwd(). Keep
  // integration-test observations in /tmp instead of mutating tracked datasets.
  cwd:   outdir,
});

process.exit(proc.status ?? 0);
