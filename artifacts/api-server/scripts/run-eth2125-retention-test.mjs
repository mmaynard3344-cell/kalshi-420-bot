/**
 * Build and run tradeStore.eth2125DepthRetention.test.ts — integration tests
 * proving ETH2125_PROSPECTIVE depth snapshots survive the target-liquidity
 * prune path (strategy exemption) and the report audit stays depth_confirmed.
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
  console.log("[run-eth2125-retention-test] SKIP — DATABASE_URL not set; no DB available.");
  process.exit(0);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root      = path.resolve(__dirname, "..");

const outdir  = "/tmp/ts-eth2125-retention-test";
const outfile = path.join(outdir, "tradeStore.eth2125DepthRetention.test.mjs");

await build({
  entryPoints: [path.join(root, "src/lib/tradeStore.eth2125DepthRetention.test.ts")],
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
