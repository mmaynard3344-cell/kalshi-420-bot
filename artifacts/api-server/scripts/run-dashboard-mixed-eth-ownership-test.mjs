/**
 * Build and run the Dashboard mixed ETH ownership regression test with
 * esbuild-plugin-pino so pino's dynamic Node requires are handled correctly.
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

const outdir = "/tmp/ts-dashboard-mixed-eth-ownership";
const outfile = path.join(outdir, "Dashboard.mixedEthOwnership.test.mjs");

await build({
  entryPoints: [path.join(root, "../kalshi-reader/src/pages/Dashboard.mixedEthOwnership.test.ts")],
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
}).catch((error) => {
  console.error(error);
  process.exit(1);
});

const proc = spawnSync(process.execPath, ["--test", outfile], {
  stdio: "inherit",
  cwd: outdir,
  env: { ...process.env },
});

process.exit(proc.status ?? 0);