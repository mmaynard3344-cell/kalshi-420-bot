import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import esbuildPluginPino from "esbuild-plugin-pino";

globalThis.require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outdir = "/tmp/ts-eth420-boundary-research";
const outfile = path.join(outdir, "eth420BoundaryResearch.test.mjs");

await build({
  entryPoints: [path.join(root, "src/lib/eth420BoundaryResearch.test.ts")],
  platform: "node", bundle: true, format: "esm", outdir,
  outExtension: { ".js": ".mjs" }, logLevel: "warning",
  banner: { js: `import { createRequire as __bannerCrReq } from 'node:module';
const require = __bannerCrReq(import.meta.url);` },
  plugins: [esbuildPluginPino({ transports: ["pino-pretty"] })],
});
const result = spawnSync(process.execPath, ["--test", outfile], {
  cwd: outdir, stdio: "inherit",
  env: { ...process.env, ETH420_BOUNDARY_RESEARCH_SOURCE: path.join(root, "src/lib/eth420BoundaryResearch.ts") },
});
process.exit(result.status ?? 0);