/**
 * Build and run ETH martingale tests with esbuild-plugin-pino.
 * The strategy imports the shared logger, whose dynamic Node requires need
 * the same Pino-aware ESM bundle configuration as the production server.
 */

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import esbuildPluginPino from "esbuild-plugin-pino";

globalThis.require = createRequire(import.meta.url);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const outdir = "/tmp/ts-eth-no-martingale";
const outfile = path.join(outdir, "ethOnlyMartingale.test.mjs");

await build({
  entryPoints: [path.join(root, "src/lib/strategies/ethOnlyMartingale.test.ts")],
  platform: "node",
  bundle: true,
  format: "esm",
  outdir,
  outExtension: { ".js": ".mjs" },
  logLevel: "warning",
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
  cwd: root,
});

process.exit(proc.status ?? 0);
