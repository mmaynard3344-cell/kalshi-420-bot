import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import esbuildPluginPino from "esbuild-plugin-pino";

globalThis.require = createRequire(import.meta.url);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tests = ["sweepReclaimV1", "sweepReclaimLiveAdmission", "sweepReclaimExecutionAdapter", "sweepReclaimLiveRuntime", "sweepReclaimLiveRecovery"];
if (process.env.L_DATABASE_TEST === "true") tests.push("sweepReclaimLiveDatabase");
for (const name of tests) {
const outdir = `/tmp/ts-l-live-${name}`;
const outfile = path.join(outdir, `${name}.test.mjs`);

await build({
  entryPoints: [path.join(root, `src/lib/strategies/${name}.test.ts`)],
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

const run = spawnSync(process.execPath, [outfile], {
  stdio: "inherit",
  cwd: root,
});
if (run.status !== 0) process.exit(run.status ?? 1);
}
