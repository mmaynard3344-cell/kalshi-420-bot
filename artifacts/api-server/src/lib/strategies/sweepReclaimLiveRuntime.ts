import { createHash } from "node:crypto";
import { kalshiSeriesFetch, normalizeMarket } from "../kalshi.js";
import { logger } from "../logger.js";
import { isTradingHalted } from "../tradingKillSwitch.js";
import { claimSweepReclaimSignal, type SweepReclaimClaimParams } from "../tradeStore.js";
import { parseKrakenEth15mPayload, selectContiguousPriorCandles } from "./krakenEth15mCandles.js";
import { executeSweepReclaimV1, type SweepReclaimExecutionInput } from "./sweepReclaimExecutionAdapter.js";
import { reconcileLSweepReclaimOrders } from "./sweepReclaimLiveRecovery.js";
import { ETH_15M_MS, PRIOR_24H_CANDLES, SWEEP_RECLAIM_STRATEGY_ID, SWEEP_RECLAIM_DISPLAY_NAME,
  evaluateSweepReclaimV1, isImmediateFollowingEth15mWindow, loadSweepReclaimRuntimeConfig,
  type Eth15mCandle, type SweepReclaimRuntimeConfig } from "./sweepReclaimV1.js";

export const L_LIVE_POLL_MS = 10_000;
type Market = Record<string, unknown>;
export interface LLiveRuntimeDeps {
  config(): SweepReclaimRuntimeConfig;
  permitted(): boolean;
  reconcile(): Promise<void>;
  currentMarket(): Promise<Market | null>;
  history(sourceOpenMs: number, nowMs: number): Promise<{ source: Eth15mCandle; prior96: Eth15mCandle[] } | null>;
  claim(input: SweepReclaimClaimParams): Promise<boolean>;
  execute(input: SweepReclaimExecutionInput): Promise<string>;
}

export function lLiveClaimId(sourceOpenMs: number, ticker: string): string {
  const hex = createHash("sha256").update(`L:SWEEP_RECLAIM_V1:${sourceOpenMs}:${ticker}`).digest("hex");
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
}

const productionDeps: LLiveRuntimeDeps = {
  config: loadSweepReclaimRuntimeConfig,
  permitted: () => !isTradingHalted(),
  reconcile: reconcileLSweepReclaimOrders,
  currentMarket: () => kalshiSeriesFetch("KXETH15M", { forceFresh: true }),
  async history(sourceOpenMs, nowMs) {
    const since = Math.floor((sourceOpenMs - PRIOR_24H_CANDLES * ETH_15M_MS) / 1000);
    const response = await fetch(`https://api.kraken.com/0/public/OHLC?pair=ETHUSD&interval=15&since=${since}`);
    if (!response.ok) return null;
    const candles = parseKrakenEth15mPayload(await response.json(), nowMs);
    const source = candles.find(c => c.openTimeMs === sourceOpenMs);
    const prior96 = selectContiguousPriorCandles(candles, sourceOpenMs, PRIOR_24H_CANDLES);
    return source && prior96 ? { source, prior96 } : null;
  },
  claim: claimSweepReclaimSignal,
  execute: executeSweepReclaimV1,
};

export async function runLSweepReclaimLiveOnce(nowMs = Date.now(), deps = productionDeps): Promise<string> {
  // Recovery continues while new entries are disabled.
  await deps.reconcile();
  const config = deps.config();
  if (!config.enabled || !config.liveExecutionEnabled || !config.activationReady || !deps.permitted()) return "disabled";
  const raw = await deps.currentMarket();
  if (!raw) return "market_unavailable";
  const market = normalizeMarket(raw);
  const ticker = market["ticker"];
  const openMs = Date.parse(String(market["open_time"] ?? ""));
  const closeMs = Date.parse(String(market["close_time"] ?? ""));
  const exchangeIndex = market["exchange_index"];
  if (typeof ticker !== "string" || !/^KXETH15M-/.test(ticker) || market["status"] !== "open"
    || !Number.isSafeInteger(openMs) || !Number.isSafeInteger(closeMs)
    || typeof exchangeIndex !== "number" || !Number.isInteger(exchangeIndex) || exchangeIndex < 0
    || nowMs < openMs || nowMs >= closeMs) return "invalid_destination";
  const history = await deps.history(openMs - ETH_15M_MS, nowMs);
  if (!history) return "source_unavailable";
  const decision = evaluateSweepReclaimV1(history.source, history.prior96);
  if (!decision.qualifies) return decision.reason;
  if (!isImmediateFollowingEth15mWindow(history.source, openMs, closeMs)) return "not_immediate_following_window";
  if (closeMs - nowMs < config.minimumSecondsRemaining! * 1000) return "too_late";
  const id = lLiveClaimId(history.source.openTimeMs, ticker);
  const e = decision.evidence;
  const claimed = await deps.claim({ id, strategyId: SWEEP_RECLAIM_STRATEGY_ID, serviceCode: "L",
    displayLabel: SWEEP_RECLAIM_DISPLAY_NAME, sourceVenue: "kraken",
    sourceCandleOpenMs: history.source.openTimeMs, sourceCandleCloseMs: history.source.closeTimeMs,
    sourceOpen: history.source.open, sourceHigh: history.source.high, sourceLow: history.source.low, sourceClose: history.source.close,
    prior24hLow: e.prior24hLow, candleRange: e.range, realBody: e.body, lowerWick: e.lowerWick, midpoint: e.midpoint,
    closePositionFraction: e.closePositionFraction, sweptPrevious24hLow: e.sweptPrevious24hLow,
    wickCondition: e.wickCondition, upperHalfClose: e.upperHalfClose, qualified: true,
    destinationTicker: ticker, side: "yes", claimedAtMs: nowMs });
  if (!claimed) return "duplicate_or_storage_unavailable";
  if (!deps.permitted()) return "halted_after_claim";
  return deps.execute({ claimId: id, destinationTicker: ticker, exchangeIndex,
    destinationCloseTimeMs: closeMs, clientOrderId: id, config });
}

export function startLSweepReclaimLiveRuntime(): () => void {
  let inFlight = false;
  const run = () => {
    if (inFlight) return;
    inFlight = true;
    void runLSweepReclaimLiveOnce().then(outcome => logger.info({ strategy: "L", mode: "live", outcome }, "L sweep/reclaim live evaluation"))
      .catch(err => logger.error({ err, strategy: "L" }, "L live iteration failed closed"))
      .finally(() => { inFlight = false; });
  };
  run();
  const timer = setInterval(run, L_LIVE_POLL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
