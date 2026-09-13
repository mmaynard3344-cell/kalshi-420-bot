import { build } from "esbuild";
import { writeFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

const apiDir = path.resolve("artifacts/api-server");
const entry = "/tmp/eth-jump-pipeline-probe-entry.ts";
const outfile = "/tmp/eth-jump-pipeline-probe-entry.cjs";

const source = `
import { kalshiFetch, kalshiSeriesFetch } from ${JSON.stringify(path.join(apiDir, "src/lib/kalshi.ts"))};
import * as tradeStore from ${JSON.stringify(path.join(apiDir, "src/lib/tradeStore.ts"))};
import { bootstrapEth420PercentileHistory } from ${JSON.stringify(path.join(apiDir, "src/lib/strategies/eth420SixStepCandidate.ts"))};
import { prepareEthJumpServiceIntent } from ${JSON.stringify(path.join(apiDir, "src/lib/strategies/ethJumpServiceRuntime.ts"))};
import { ethBigBetExecutionStore } from ${JSON.stringify(path.join(apiDir, "src/lib/strategies/ethBigBetExecutionStoreAdapter.ts"))};
import { initEthBigBetStore, markEthBigBetRejected } from ${JSON.stringify(path.join(apiDir, "src/lib/strategies/ethBigBetStore.ts"))};
import { ethBigBetCapitalRiskCents, ethBigBetContracts, ethBigBetOrderId, mayEvaluateBigBetMarket } from ${JSON.stringify(path.join(apiDir, "src/lib/strategies/ethBigBetLifecycle.ts"))};

const SYNTHETIC_MOVE = 0.006;
const capital = { availableBalanceCents: 100_000_000, martingaleReserveCents: 0, safetyReserveCents: 0 };

function easternDate(ms: number): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(ms));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return get("year") + "-" + get("month") + "-" + get("day");
}
function strike(raw: Record<string, unknown> | null | undefined): number | null {
  if (!raw) return null;
  const value = raw["floor_strike"] ?? raw["cap_strike"];
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function main() {
  let orderId: string | null = null;
  let reserved = false;
  try {
    await initEthBigBetStore();
    const bootstrapped = await bootstrapEth420PercentileHistory();
    if (!bootstrapped) throw new Error("percentile_bootstrap_unavailable");

    const current = await kalshiSeriesFetch("KXETH15M", { forceFresh: true });
    const ticker = typeof current?.["ticker"] === "string" ? current["ticker"] : null;
    const openTimeMs = typeof current?.["open_time"] === "string" ? Date.parse(current["open_time"] as string) : NaN;
    if (!ticker || !/^KXETH15M-/.test(ticker) || !Number.isInteger(openTimeMs)) throw new Error("current_eth15m_market_unavailable");

    const priorOpenMs = openTimeMs - 15 * 60_000;
    const priorPage = await kalshiFetch<{ markets?: Array<Record<string, unknown>> }>("/markets", { series_ticker: "KXETH15M", status: "settled", limit: 100 });
    const exactPrior = (priorPage.markets ?? []).filter((row) => {
      const t = typeof row["open_time"] === "string" ? Date.parse(row["open_time"] as string) : NaN;
      return t === priorOpenMs && typeof row["ticker"] === "string" && /^KXETH15M-/.test(row["ticker"] as string);
    });
    const priorStrikes = [...new Set(exactPrior.map(strike).filter((v): v is number => v != null))];
    if (priorStrikes.length !== 1) throw new Error("exact_prior_strike_unavailable");
    const priorStrike = priorStrikes[0]!;
    const syntheticFloorStrike = priorStrike * (1 + SYNTHETIC_MOVE);

    const market = { ticker, easternDate: easternDate(openTimeMs), observedAtMs: Date.now(), openTimeMs, floorStrike: syntheticFloorStrike };
    const evaluationStore = { getEth420CandidateState: tradeStore.getEth420CandidateState, listEth420CandidateTelemetry: tradeStore.listEth420CandidateTelemetry };
    let observation: any = null;
    console.log("ETH_JUMP_PIPELINE_PROBE_START", { ticker, openTimeMs, priorOpenMs, priorStrike, syntheticFloorStrike, forcedCurrentMove: SYNTHETIC_MOVE });

    const intent = await prepareEthJumpServiceIntent({ store: evaluationStore, market, role: "jump", onEvaluation: (value) => { observation = value; } });
    console.log("ETH_JUMP_PIPELINE_PROBE_QUALIFICATION", { observation, qualified: intent != null, intent });
    if (!intent) { console.log("ETH_JUMP_PIPELINE_PROBE_RESULT", { result: "qualification_exit", observation }); return; }

    orderId = ethBigBetOrderId(intent);
    const requestedContracts = ethBigBetContracts(intent.wagerCents, intent.limitPriceCents);
    const requestedRiskCents = ethBigBetCapitalRiskCents(intent.wagerCents, intent.limitPriceCents);
    const unresolved = await ethBigBetExecutionStore.listUnresolvedEthBigBetOrderIds(intent.strategy);
    const mayEvaluate = mayEvaluateBigBetMarket({ targetOrderId: orderId, unresolvedOrderIds: unresolved });
    console.log("ETH_JUMP_PIPELINE_PROBE_PRE_RESERVE", { orderId, requestedContracts, requestedRiskCents, mayEvaluate, unresolvedCount: unresolved.length });
    if (!mayEvaluate) { console.log("ETH_JUMP_PIPELINE_PROBE_RESULT", { result: "blocked_duplicate", orderId }); return; }
    if (requestedContracts < 1 || !Number.isSafeInteger(requestedRiskCents) || requestedRiskCents < 1) { console.log("ETH_JUMP_PIPELINE_PROBE_RESULT", { result: "blocked_invalid_size", orderId }); return; }

    const reservation = await ethBigBetExecutionStore.reserveEthBigBetOrder({ orderId, intent, requestedContracts, requestedRiskCents, capital, reservedAtMs: Date.now() });
    reserved = reservation === "reserved";
    console.log("ETH_JUMP_PIPELINE_PROBE_RESULT", { result: reservation, orderId, qualified: true, reachedReserveEthBigBetOrder: true, exchangeSubmitCalled: false });
  } catch (err) {
    console.error("ETH_JUMP_PIPELINE_PROBE_THROWN", { orderId, message: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : null });
    process.exitCode = 2;
  } finally {
    if (reserved && orderId) {
      try {
        const cleaned = await markEthBigBetRejected(orderId);
        console.log("ETH_JUMP_PIPELINE_PROBE_CLEANUP", { orderId, cleaned });
      } catch (err) {
        console.error("ETH_JUMP_PIPELINE_PROBE_CLEANUP_FAILED", { orderId, message: err instanceof Error ? err.message : String(err) });
        process.exitCode = 3;
      }
    }
  }
}
void main();
`;

await writeFile(entry, source, "utf8");
try {
  await build({ entryPoints: [entry], bundle: true, platform: "node", format: "cjs", outfile, sourcemap: false, logLevel: "silent", external: ["pg-native"] });
  const run = spawnSync(process.execPath, [outfile], { stdio: "inherit", env: process.env });
  if (run.error) throw run.error;
  if (run.status !== 0) process.exitCode = run.status ?? 1;
} finally {
  await rm(entry, { force: true });
  await rm(outfile, { force: true });
}
