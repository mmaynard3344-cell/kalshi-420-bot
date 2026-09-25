import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import esbuildPluginPino from "esbuild-plugin-pino";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
globalThis.require = createRequire(import.meta.url);
const outdir = "/tmp/ts-a2-baseline-reversion";

await build({
  entryPoints:[
    path.join(root,"src/lib/strategies/a2BaselineReversion.test.ts"),
    path.join(root,"src/lib/strategies/a2BaselineReversionShadow.test.ts"),
    path.join(root,"src/lib/strategies/a2BaselineReversionRuntime.test.ts"),
  ],
  platform:"node",
  bundle:true,
  format:"esm",
  outdir,
  outExtension:{".js":".mjs"},
  logLevel:"warning",
  banner: {
    js: `import { createRequire as __bannerCrReq } from 'node:module';
import __bannerPath from 'node:path';
import { fileURLToPath as __bannerFtu } from 'node:url';
const require = __bannerCrReq(__bannerFtu(import.meta.url));
const __filename = __bannerFtu(import.meta.url);
const __dirname = __bannerPath.dirname(__filename);`,
  },
  plugins:[esbuildPluginPino({ transports:["pino-pretty"] })],
});

const files = [
  path.join(outdir,"a2BaselineReversion.test.mjs"),
  path.join(outdir,"a2BaselineReversionShadow.test.mjs"),
  path.join(outdir,"a2BaselineReversionRuntime.test.mjs"),
];
const run=spawnSync(process.execPath,["--test",...files],{stdio:"inherit",cwd:root});
process.exit(run.status??1);
