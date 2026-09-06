import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import esbuildPluginPino from "esbuild-plugin-pino";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
globalThis.require = createRequire(import.meta.url);
const testFiles = [
  "src/lib/strategies/ethServiceIsolation.test.ts",
  "src/lib/strategies/ethBigBetLifecycle.test.ts",
  "src/lib/strategies/ethBigBetExecutor.test.ts",
  "src/lib/strategies/ethAccountCapitalGuard.test.ts",
  "src/lib/strategies/ethBigBetCapitalFacts.test.ts",
  "src/lib/strategies/ethBigBetCapitalPolicy.test.ts",
  "src/lib/strategies/ethBigBetApprovedCapitalProvider.test.ts",
  "src/lib/strategies/ethBigBetSettlementReconciler.test.ts",
  "src/lib/strategies/ethBigBetSettlementStore.test.ts",
  "src/lib/strategies/ethServiceACutover.test.ts",
  "src/lib/strategies/ethJumpServiceRuntime.test.ts",
  "src/lib/strategies/ethBigBetStore.test.ts",
  "src/lib/strategies/ethJumpLiveRunner.test.ts",
  "src/lib/strategies/ethReversalServiceRuntime.test.ts",
  "src/lib/strategies/ethReversalLiveRunner.test.ts",
];

const compiled = [];
for (const [index, file] of testFiles.entries()) {
  const outdir = `/tmp/service-split-test-${index}`;
  const result = await build({
    entryPoints: [path.join(root, file)],
    platform: "node",
    bundle: true,
    format: "esm",
    outdir,
    outExtension: { ".js": ".mjs" },
    metafile: true,
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
  const output = Object.entries(result.metafile.outputs)
    .find(([, metadata]) => metadata.entryPoint === file)?.[0];
  if (!output) throw new Error(`Compiled test entry not found for ${file}`);
  compiled.push(path.resolve(output));
}

execFileSync(process.execPath, ["--test", ...compiled], { cwd: root, stdio: "inherit" });
