import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import esbuildPluginPino from "esbuild-plugin-pino";

globalThis.require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outdir = "/tmp/ts-jackpot-test";
const outfile = path.join(outdir, "ethJackpotService.test.mjs");

await build({
  entryPoints: [path.join(root, "src/lib/strategies/ethJackpotService.test.ts")],
  platform: "node",
  bundle: true,
  format: "esm",
  outdir,
  outExtension: { ".js": ".mjs" },
  logLevel: "warning",
  banner: {
    js: `import { createRequire as __bannerCrReq } from 'node:module';\nimport __bannerPath from 'node:path';\nimport { fileURLToPath as __bannerFtu } from 'node:url';\nconst require = __bannerCrReq(__bannerFtu(import.meta.url));\nconst __filename = __bannerFtu(import.meta.url);\nconst __dirname = __bannerPath.dirname(__filename);`,
  },
  plugins: [esbuildPluginPino({ transports: ["pino-pretty"] })],
});
const result = spawnSync(process.execPath, ["--test", outfile], { stdio: "inherit", cwd: outdir });
process.exit(result.status ?? 1);
