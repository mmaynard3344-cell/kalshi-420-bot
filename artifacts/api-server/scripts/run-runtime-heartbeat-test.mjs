/**
 * Build and run runtime-heartbeat tests with the same Pino-safe configuration
 * used by the production API build.
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
const outdir = "/tmp/ts-runtime-heartbeat";
const outfile = path.join(outdir, "runtimeHeartbeat.test.mjs");

await build({
  entryPoints: [path.join(root, "src/lib/runtimeHeartbeat.test.ts")],
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

const proc = spawnSync(process.execPath, ["--test", outfile], { stdio: "inherit", cwd: root });
process.exit(proc.status ?? 0);