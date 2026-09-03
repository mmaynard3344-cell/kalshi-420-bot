import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import esbuildPluginPino from "esbuild-plugin-pino";

globalThis.require = createRequire(import.meta.url);
if (!process.env.DATABASE_URL) {
  console.log("[run-eth420-counterfactual-test] SKIP — DATABASE_URL not set.");
  process.exit(0);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outdir = "/tmp/ts-eth420-counterfactual";
const outfile = path.join(outdir, "eth420CounterfactualRecorder.test.mjs");
await build({
  entryPoints: [path.join(root, "src/lib/eth420CounterfactualRecorder.test.ts")],
  platform: "node", bundle: true, format: "esm", outdir,
  outExtension: { ".js": ".mjs" }, logLevel: "warning",
  banner: { js: `import { createRequire as __cr } from 'node:module'; import { fileURLToPath as __ftu } from 'node:url'; const require = __cr(__ftu(import.meta.url));` },
  plugins: [esbuildPluginPino({ transports: ["pino-pretty"] })],
});
const run = spawnSync(process.execPath, ["--test", outfile], { stdio: "inherit", cwd: root });
process.exit(run.status ?? 1);