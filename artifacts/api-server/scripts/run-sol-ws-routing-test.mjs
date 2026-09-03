/**
 * Build and run the SOL WebSocket routing regression tests using
 * esbuild-plugin-pino so pino's CJS dynamic requires are handled
 * correctly in ESM bundles.
 *
 * Data-directory isolation: operational data files in data/ are never
 * touched because we redirect all writable paths to temp dirs before
 * the module bundle loads.
 */

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { build } from "esbuild";
import esbuildPluginPino from "esbuild-plugin-pino";

globalThis.require = createRequire(import.meta.url);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root      = path.resolve(__dirname, "..");

// ── Redirect all data-writing paths to temp dirs ─────────────────────────────
// Without this, importing autoTrader.ts triggers startup I/O that writes to
// the tracked operational files in data/.  Each env var matches the override
// checked by its respective module before falling back to process.cwd().

const tmpCoverage = mkdtempSync(path.join(tmpdir(), "sol-ws-coverage-"));
const tmpPhase4b  = mkdtempSync(path.join(tmpdir(), "sol-ws-phase4b-"));
const tmpAnalytics = mkdtempSync(path.join(tmpdir(), "sol-ws-analytics-"));

// marketDataCoverage.ts reads COVERAGE_DATA_DIR
process.env["COVERAGE_DATA_DIR"] = tmpCoverage;
// phase4b/passiveCapture.ts reads PHASE4B_CAPTURE_SPOOL_PATH
process.env["PHASE4B_CAPTURE_SPOOL_PATH"] = path.join(tmpPhase4b, "spool.ndjson");
// Any other module that might write to data/analytics
process.env["ANALYTICS_DATA_DIR"] = tmpAnalytics;

const outdir  = "/tmp/ts-sol-ws";
const outfile = path.join(outdir, "autoTrader.sol-ws-routing.test.mjs");

const result = await build({
  entryPoints: [path.join(root, "src/lib/autoTrader.sol-ws-routing.test.ts")],
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
  cwd:   root,
  env: {
    ...process.env,
    COVERAGE_DATA_DIR:          tmpCoverage,
    PHASE4B_CAPTURE_SPOOL_PATH: path.join(tmpPhase4b, "spool.ndjson"),
    ANALYTICS_DATA_DIR:         tmpAnalytics,
  },
});

process.exit(proc.status ?? 0);
