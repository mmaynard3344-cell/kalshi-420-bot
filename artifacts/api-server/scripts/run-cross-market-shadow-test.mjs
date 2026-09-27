import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import esbuildPluginPino from "esbuild-plugin-pino";

globalThis.require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const out = "/tmp/ts-cross-market-shadow/crossMarketShadowStudy.test.mjs";
const BANNER = `import { createRequire as __cr } from 'node:module'; import { fileURLToPath as __fu } from 'node:url'; const require = __cr(__fu(import.meta.url));`;

await build({
  entryPoints: [path.join(root, "src/lib/crossMarketShadowStudy.test.ts")],
  platform: "node", bundle: true, format: "esm", outfile: out, logLevel: "warning",
  banner: { js: BANNER }, plugins: [esbuildPluginPino({ transports: ["pino-pretty"] })],
});
const proc = spawnSync(process.execPath, ["--test", out], { stdio: "inherit", cwd: root });
process.exit(proc.status ?? 1);
