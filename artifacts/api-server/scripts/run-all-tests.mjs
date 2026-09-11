import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import esbuildPluginPino from "esbuild-plugin-pino";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
globalThis.require = createRequire(import.meta.url);
const testFiles = [
  "src/lib/dailyBudget.test.ts",
  "src/lib/dailyProfitStop.test.ts",
  "src/strategy/strategy.test.ts",
  "src/strategy/equivalence.test.ts",
  // The dispatcher-boundary suite uses pino and is run below with the
  // JavaScript esbuild API. Pure historical guards remain safe here.
  "src/lib/autoTraderGuards.test.ts",
  "src/lib/recordParser.test.ts",
  "src/lib/orderbookCapture.test.ts",
  "src/lib/orderResponseParser.test.ts",
  "src/lib/strategyConstants.sync.test.ts",
  "src/lib/ethBoundarySettlementOrchestrator.test.ts",
  "src/lib/eth420BoundarySettlementOrchestrator.test.ts",
  "src/lib/eth420RunawayResearch.test.ts",
  "src/lib/strategies/ethServiceIsolation.test.ts",
  "src/lib/strategies/ethServiceEnablementContract.test.ts",
  "src/lib/strategies/ethBigBetLifecycle.test.ts",
  "src/lib/strategies/ethBigBetExecutor.test.ts",
  "src/lib/strategies/ethAccountCapitalGuard.test.ts",
  "src/lib/strategies/ethBigBetCapitalFacts.test.ts",
  "src/lib/strategies/ethBigBetCapitalPolicy.test.ts",
  "src/lib/strategies/ethServiceACutover.test.ts",
  "src/lib/strategies/ethJumpServiceRuntime.test.ts",
  "src/lib/strategies/ethBigBetStore.test.ts",
  "src/lib/strategies/ethJumpLiveRunner.test.ts",
  "src/lib/strategies/ethReversalServiceRuntime.test.ts",
  "src/lib/strategies/ethReversalLiveRunner.test.ts",
];

const compiledTests = [];
for (const [index, file] of testFiles.entries()) {
  const outdir = `/tmp/api-test-${index}`;
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
  const outfile = path.resolve(output);
  compiledTests.push(outfile);
}

const run = (command, args) => execFileSync(command, args, { cwd: root, stdio: "inherit" });

run(process.execPath, ["scripts/run-integration-test.mjs"]);
run(process.execPath, ["scripts/run-recoverability-capture-test.mjs"]);
run(process.execPath, ["scripts/run-doge-no-martingale-test.mjs"]);
run(process.execPath, ["scripts/run-trade-manual-order-boundary-test.mjs"]);
run(process.execPath, ["scripts/run-eth420-live-market-test.mjs"]);
run(process.execPath, ["scripts/run-eth420-boundary-research-test.mjs"]);
// The dispatcher-boundary test uses pino, so run it with the dedicated
// JavaScript esbuild API. Pure historical guards remain safe here.
run(process.execPath, ["scripts/run-autotrader-test.mjs"]);
run(process.execPath, ["scripts/run-kalshi-lifecycle-transport-test.mjs"]);
// The dashboard regression imports API models that use pino, so it needs the
// same pino-aware bundling path instead of the plain esbuild compilation above.
run(process.execPath, ["scripts/run-dashboard-mixed-eth-ownership-test.mjs"]);
run(process.execPath, ["scripts/run-eth420-six-step-candidate-test.mjs"]);
run(process.execPath, ["scripts/run-sol-ws-routing-test.mjs"]);
run(process.execPath, ["--test", ...compiledTests]);
run(process.execPath, ["scripts/run-fillreconciler-test.mjs"]);
run(process.execPath, ["scripts/run-exact-accounting-test.mjs"]);
run(process.execPath, ["scripts/run-parsefillactuals-test.mjs"]);
run(process.execPath, ["scripts/run-tradestore-test.mjs"]);
run(process.execPath, ["scripts/run-eth420-counterfactual-test.mjs"]);
run(process.execPath, ["scripts/run-eth420-candidate-live-isolation-test.mjs"]);
run(process.execPath, ["scripts/run-storage-health-test.mjs"]);
run(process.execPath, ["scripts/run-db-contention-test.mjs"]);
run(process.execPath, ["scripts/run-daily-verified-test.mjs"]);
run(process.execPath, ["scripts/run-eth-no-martingale-test.mjs"]);
run(process.execPath, ["scripts/run-eth-gateway-head-equivalence-test.mjs"]);
