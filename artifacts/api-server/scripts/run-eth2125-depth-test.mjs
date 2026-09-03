/**
 * Build and run the ETH 21–25¢ prospective depth-audit test suite with
 * esbuild-plugin-pino so pino's CJS dynamic-require works inside an ESM bundle
 * (the suite transitively imports tradeStore → logger → pino).
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

const BANNER = `import { createRequire as __bannerCrReq } from 'node:module';
import __bannerPath from 'node:path';
import { fileURLToPath as __bannerFtu } from 'node:url';
const require = __bannerCrReq(__bannerFtu(import.meta.url));
const __filename = __bannerFtu(import.meta.url);
const __dirname = __bannerPath.dirname(__filename);`;

const outdir  = "/tmp/ts-eth2125-depth";
const outfile = path.join(outdir, "eth2125Prospective.depthAudit.test.mjs");

await build({
  entryPoints: [path.join(root, "src/lib/strategies/eth2125Prospective.depthAudit.test.ts")],
  platform:    "node",
  bundle:      true,
  format:      "esm",
  outdir,
  outExtension: { ".js": ".mjs" },
  logLevel:    "warning",
  banner:      { js: BANNER },
  plugins:     [esbuildPluginPino({ transports: ["pino-pretty"] })],
}).catch((err) => { console.error(err); process.exit(1); });

const proc = spawnSync(process.execPath, ["--test", outfile], { stdio: "inherit", cwd: root });
process.exit(proc.status ?? 1);
