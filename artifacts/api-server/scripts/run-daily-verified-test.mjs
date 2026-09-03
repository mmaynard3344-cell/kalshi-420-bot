/**
 * Build and run the analytics.dailyVerified.test.ts integration tests using
 * esbuild-plugin-pino (required for pino CJS/ESM compatibility in bundled tests)
 * then fork a child process to run them.
 *
 * DB-skip guard: when DATABASE_URL is absent the script exits 0 with a SKIP
 * message so CI does not fail in environments without a database. The in-memory
 * section of the test file still runs as part of the standard non-DB test batch
 * in run-all-tests.mjs; this script only adds the DB-backed describe block.
 */

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import esbuildPluginPino from "esbuild-plugin-pino";

globalThis.require = createRequire(import.meta.url);

if (!process.env.DATABASE_URL) {
  console.log("[run-daily-verified-test] SKIP — DATABASE_URL not set; no DB available.");
  process.exit(0);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root      = path.resolve(__dirname, "..");

const outdir  = "/tmp/ts-daily-verified";
const outfile = path.join(outdir, "analytics.dailyVerified.test.mjs");

await build({
  entryPoints: [path.join(root, "src/lib/analytics.dailyVerified.test.ts")],
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
});

process.exit(proc.status ?? 0);
