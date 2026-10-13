import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import esbuildPluginPino from "esbuild-plugin-pino";

globalThis.require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outdir = "/tmp/eth-g-direction-review-test";
await build({
  entryPoints: [path.join(root, "src/lib/strategies/ethBigBetExecutor.test.ts")],
  platform: "node",
  bundle: true,
  format: "esm",
  outdir,
  outExtension: { ".js": ".mjs" },
  logLevel: "warning",
  banner: { js: `import { createRequire as __r } from "node:module"; import __p from "node:path"; import { fileURLToPath as __f } from "node:url"; const require=__r(import.meta.url); const __filename=__f(import.meta.url); const __dirname=__p.dirname(__filename);` },
  plugins: [esbuildPluginPino({ transports: ["pino-pretty"] })],
});
const child = spawnSync(process.execPath, ["--test", path.join(outdir, "ethBigBetExecutor.test.mjs")], { cwd: root, stdio: "inherit" });
process.exit(child.status ?? 1);
