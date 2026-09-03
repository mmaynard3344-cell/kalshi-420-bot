/**
 * Build and run the fillReconciler.exactAccounting.test.ts with esbuild-plugin-pino
 * so pino's CJS dynamic-require works inside an ESM bundle.
 *
 * Pure in-memory unit tests — no DATABASE_URL needed.
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

const outdir  = "/tmp/ts-exact-accounting";
const outfile = path.join(outdir, "fillReconciler.exactAccounting.test.mjs");

const result = await build({
  entryPoints: [path.join(root, "src/lib/fillReconciler.exactAccounting.test.ts")],
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
});

process.exit(proc.status ?? 0);
