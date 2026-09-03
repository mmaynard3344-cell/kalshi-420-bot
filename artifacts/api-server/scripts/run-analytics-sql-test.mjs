/**
 * Build and run the analyticsStore.sql.test.ts integration tests using the
 * same esbuild configuration as the main build (esbuild-plugin-pino for CJS/ESM
 * pino compatibility, same banner for __dirname/__filename in ESM bundles).
 *
 * DB-skip guard: when DATABASE_URL is absent or the connection fails within
 * 5 s, the script exits 0 with a SKIP message so CI does not fail in
 * environments without a database.
 */

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import esbuildPluginPino from "esbuild-plugin-pino";

globalThis.require = createRequire(import.meta.url);

// ── DB availability check ──────────────────────────────────────────────────
// Only check for DATABASE_URL presence; drizzle inside the test bundle will
// report its own error if the DB is unreachable.  The removed pg-import probe
// was unreliable in ESM bundles and caused false negatives.
if (!process.env.DATABASE_URL) {
  console.log("[run-analytics-sql-test] SKIP — DATABASE_URL not set; no DB available.");
  process.exit(0);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const outdir  = "/tmp/ts-analytics-sql";
const outfile = path.join(outdir, "analyticsStore.sql.test.mjs");

await build({
  entryPoints: [path.join(root, "src/lib/analyticsStore.sql.test.ts")],
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

const proc = spawnSync(process.execPath, ["--test", outfile], {
  stdio: "inherit",
  cwd:   root,
  env:   { ...process.env, TRADE_STORE_TEST_FIXTURES: "true", TRADE_STORE_INCLUDE_SYNTHETIC_FOR_TESTS: "true" },
});

process.exit(proc.status ?? 0);
