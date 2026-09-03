import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import esbuildPluginPino from "esbuild-plugin-pino";

globalThis.require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outdir = "/tmp/ts-storage-health";
await build({
  entryPoints: [path.join(root, "src/lib/tradeStore.storageHealth.test.ts")],
  platform: "node", bundle: true, format: "esm", outdir, outExtension: { ".js": ".mjs" },
  banner: { js: `import { createRequire as c } from 'node:module'; const require=c(import.meta.url);` },
  plugins: [esbuildPluginPino({ transports: ["pino-pretty"] })],
});
const result = spawnSync(process.execPath, ["--test", path.join(outdir, "tradeStore.storageHealth.test.mjs")], { cwd: root, stdio: "inherit" });
process.exit(result.status ?? 1);