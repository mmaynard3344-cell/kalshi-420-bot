import { build } from "esbuild";
import { writeFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

const apiDir = path.resolve("artifacts/api-server");
const entry = "/tmp/eth-reservation-probe-entry.ts";
const outfile = "/tmp/eth-reservation-probe-entry.cjs";

const ticker = "KXETH15M-26SEP131745-45";
const marketOpenTimeMs = Date.parse("2026-09-13T21:45:00.000Z");
const orderTag = "diagnostic-reservation-probe-v1";

const source = `
import { reserveEthBigBetIntentWithCapital } from ${JSON.stringify(path.join(apiDir, "src/lib/strategies/ethBigBetStore.ts"))};
import { ethBigBetCapitalRiskCents, ethBigBetOrderId } from ${JSON.stringify(path.join(apiDir, "src/lib/strategies/ethBigBetLifecycle.ts"))};

async function main() {
  const intent = {
    strategy: "jump" as const,
    orderTag: ${JSON.stringify(orderTag)},
    ticker: ${JSON.stringify(ticker)},
    side: "no" as const,
    wagerCents: 100,
    limitPriceCents: 50,
    marketOpenTimeMs: ${marketOpenTimeMs},
  };
  const requestedRiskCents = ethBigBetCapitalRiskCents(intent.wagerCents, intent.limitPriceCents);
  const orderId = ethBigBetOrderId(intent);
  const capital = {
    availableBalanceCents: 100_000_000,
    martingaleReserveCents: 0,
    safetyReserveCents: 0,
  };
  console.log("ETH_RESERVATION_PROBE_START", { orderId, intent, requestedRiskCents, capital });
  try {
    const result = await reserveEthBigBetIntentWithCapital({ intent, capital, requestedRiskCents });
    console.log("ETH_RESERVATION_PROBE_RESULT", { result, orderId, strategy: intent.strategy, orderTag: intent.orderTag, ticker: intent.ticker });
  } catch (err) {
    console.error("ETH_RESERVATION_PROBE_THROWN", {
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : null,
    });
    process.exitCode = 2;
  }
}

void main();
`;

await writeFile(entry, source, "utf8");
try {
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    sourcemap: false,
    logLevel: "silent",
    external: ["pg-native"],
  });
  const run = spawnSync(process.execPath, [outfile], { stdio: "inherit", env: process.env });
  if (run.error) throw run.error;
  if (run.status !== 0) process.exitCode = run.status ?? 1;
} finally {
  await rm(entry, { force: true });
  await rm(outfile, { force: true });
}
