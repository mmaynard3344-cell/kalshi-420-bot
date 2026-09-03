import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import esbuildPluginPino from "esbuild-plugin-pino";

globalThis.require = createRequire(import.meta.url);

if (!process.env.DATABASE_URL) {
  console.log("[run-db-contention-test] SKIP — DATABASE_URL not set; no DB available.");
  process.exit(0);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const outdir = "/tmp/ts-db-contention";
const outfile = path.join(outdir, "tradeStore.dbContention.test.mjs");

await build({
  entryPoints: [path.join(root, "src/lib/tradeStore.dbContention.test.ts")],
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
});

const proc = spawnSync(process.execPath, ["--test", outfile], {
  stdio: "inherit",
  cwd: root,
  env: { ...process.env, TRADE_STORE_TEST_FIXTURES: "true", TRADE_STORE_INCLUDE_SYNTHETIC_FOR_TESTS: "true" },
});

if (proc.error) {
  console.error("[run-db-contention-test] failed to start test process:", proc.error.message);
  process.exit(1);
}
process.exit(proc.status ?? 1);