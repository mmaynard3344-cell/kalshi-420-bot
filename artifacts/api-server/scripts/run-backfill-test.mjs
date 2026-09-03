/**
 * Build and run the analyticsStore.backfill.test.ts integration tests.
 *
 * Confirms backfilled orders have win/P&L in both in-memory state and the
 * NDJSON file, so win/loss survives two consecutive server restarts.
 *
 * DB-skip guard: exits 0 when DATABASE_URL is absent.
 */

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import esbuildPluginPino from "esbuild-plugin-pino";

globalThis.require = createRequire(import.meta.url);

if (!process.env.DATABASE_URL) {
  console.log("[run-backfill-test] SKIP — DATABASE_URL not set; no DB available.");
  process.exit(0);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const outdir  = "/tmp/ts-backfill-test";
const outfile = path.join(outdir, "analyticsStore.backfill.test.mjs");

await build({
  entryPoints: [path.join(root, "src/lib/analyticsStore.backfill.test.ts")],
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
