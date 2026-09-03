/**
 * Build and run the ETH 420 emergency-reduction route tests with the same
 * Pino-aware ESM harness used by the candidate lifecycle suites.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import esbuildPluginPino from "esbuild-plugin-pino";

globalThis.require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outdir = "/tmp/ts-eth420-emergency-reduction";
const outfile = path.join(outdir, "trade.martingale.test.mjs");

await build({
  entryPoints: [path.join(root, "src/routes/trade.martingale.test.ts")],
  platform: "node",
  bundle: true,
  format: "esm",
  outdir,
  outExtension: { ".js": ".mjs" },
  logLevel: "warning",
  banner: {
    js: `import { createRequire as __cr } from 'node:module'; import { fileURLToPath as __ftu } from 'node:url'; const require = __cr(__ftu(import.meta.url));`,
  },
  plugins: [esbuildPluginPino({ transports: ["pino-pretty"] })],
});

const run = spawnSync(process.execPath, ["--test", outfile], {
  stdio: "inherit",
  cwd: root,
});
process.exit(run.status ?? 1);