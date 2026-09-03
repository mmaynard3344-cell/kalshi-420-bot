/**
 * Build and run the tradeStore.pruneIncidents.test.ts integration tests.
 *
 * Confirms that pruneCoverageIncidents():
 *   • Deletes rows older than the retention window
 *   • Leaves rows within the retention window untouched
 *   • Returns the count of pruned rows
 *   • Returns -1 (skipped) when storage is degraded
 *   • Is idempotent (second call deletes 0 additional rows)
 *
 * DB-skip guard: exits 0 when DATABASE_URL is absent.
 */

import { createRequire } from "node:module";
import path              from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync }     from "node:child_process";
import { build }         from "esbuild";
import esbuildPluginPino from "esbuild-plugin-pino";

globalThis.require = createRequire(import.meta.url);

if (!process.env.DATABASE_URL) {
  console.log("[run-prune-incidents-test] SKIP — DATABASE_URL not set; no DB available.");
  process.exit(0);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root      = path.resolve(__dirname, "..");

const outdir  = "/tmp/ts-prune-incidents-test";
const outfile = path.join(outdir, "tradeStore.pruneIncidents.test.mjs");

await build({
  entryPoints: [path.join(root, "src/lib/tradeStore.pruneIncidents.test.ts")],
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
