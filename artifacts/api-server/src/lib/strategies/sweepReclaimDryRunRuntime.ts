import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { kalshiFetch, kalshiSeriesFetch, normalizeMarket } from "../kalshi.js";
import { logger } from "../logger.js";
import { recordShadowEvaluation, type ShadowEvaluationEventInput } from "../shadowEvaluationTelemetry.js";
import {
  ETH_15M_MS,
  PRIOR_24H_CANDLES,
  evaluateSweepReclaimV1,
  isImmediateFollowingEth15mWindow,
  loadSweepReclaimRuntimeConfig,
  type Eth15mCandle,
} from "./sweepReclaimV1.js";

export const L_DRY_RUN_POLL_MS = 10_000;

type RawMarket = Record<string, unknown>;

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  return (result as { rows?: Array<Record<string, unknown>> })?.rows ?? [];
}

function deterministicId(sourceOpenTimeMs: number, ticker: string): string {
  return `l:${sourceOpenTimeMs}:${ticker}:v1`;
}

export function buildLDryRunOrderSize(stakeCents:number,maxEntryPriceCents:number):{
  contracts:number;maxPrincipalCents:number;feeHeadroomCents:number;requestedRiskCents:number;
}|null{
  if(!Number.isSafeInteger(stakeCents)||stakeCents<=0||!Number.isInteger(maxEntryPriceCents)||maxEntryPriceCents<1||maxEntryPriceCents>99) return null;
  const contracts=Math.floor(stakeCents/maxEntryPriceCents);
  if(contracts<1) return null;
  const maxPrincipalCents=contracts*maxEntryPriceCents;
  const feeHeadroomCents=Math.ceil(0.07*contracts*maxEntryPriceCents*(100-maxEntryPriceCents)/100);
  const requestedRiskCents=maxPrincipalCents+feeHeadroomCents;
  return Number.isSafeInteger(requestedRiskCents)?{contracts,maxPrincipalCents,feeHeadroomCents,requestedRiskCents}:null;
}

export async function ensureLSweepReclaimDryRunSchema(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS l_sweep_reclaim_dry_run_intents (
      id text PRIMARY KEY,
      source_open_time_ms bigint NOT NULL,
      destination_ticker text NOT NULL,
      side text NOT NULL DEFAULT 'yes',
      state text NOT NULL,
      executable_yes_price_cents integer,
      contracts integer,
      principal_cents integer,
      fee_headroom_cents integer,
      requested_risk_cents integer,
      payload_json jsonb,
      settlement_result text,
      simulated_pnl_cents integer,
      created_at_ms bigint NOT NULL,
      updated_at_ms bigint NOT NULL,
      UNIQUE(source_open_time_ms, destination_ticker)
    );
    CREATE INDEX IF NOT EXISTS l_sweep_reclaim_dry_run_state_idx
      ON l_sweep_reclaim_dry_run_intents(state, updated_at_ms);
  `);
}

export function parseKrakenEth15mRows(
  payload: unknown,
  startOpenTimeMs: number,
  count: number,
  nowMs: number,
): Eth15mCandle[] {
  const result = (payload as { result?: Record<string, unknown> })?.result;
  if (!result || typeof result !== "object") return [];
  const rawRows = Object.entries(result)
    .filter(([key, value]) => key !== "last" && Array.isArray(value))
    .flatMap(([, value]) => value as unknown[]);
  const byOpen = new Map<number, unknown[]>();
  for (const candidate of rawRows) {
    if (!Array.isArray(candidate)) continue;
    const openMs = Number(candidate[0]) * 1000;
    if (Number.isSafeInteger(openMs)) byOpen.set(openMs, candidate);
  }
  const out: Eth15mCandle[] = [];
  for (let i=0;i<count;i++) {
    const openTimeMs = startOpenTimeMs + i * ETH_15M_MS;
    const row = byOpen.get(openTimeMs);
    if (!row) return [];
    const open=Number(row[1]), high=Number(row[2]), low=Number(row[3]), close=Number(row[4]);
    if (![open,high,low,close].every(Number.isFinite)) return [];
    out.push({
      openTimeMs,
      closeTimeMs: openTimeMs + ETH_15M_MS,
      open, high, low, close,
      finalized: nowMs >= openTimeMs + ETH_15M_MS,
    });
  }
  return out;
}

async function fetchEthHistory(sourceOpenTimeMs: number, nowMs: number): Promise<{prior96:Eth15mCandle[];source:Eth15mCandle}|null> {
  const start = sourceOpenTimeMs - PRIOR_24H_CANDLES * ETH_15M_MS;
  const since = Math.floor(start / 1000);
  const response = await fetch(`https://api.kraken.com/0/public/OHLC?pair=ETHUSD&interval=15&since=${since}`);
  if (!response.ok) return null;
  const rows = parseKrakenEth15mRows(await response.json(), start, PRIOR_24H_CANDLES + 1, nowMs);
  if (rows.length !== PRIOR_24H_CANDLES + 1) return null;
  return { prior96: rows.slice(0, PRIOR_24H_CANDLES), source: rows[PRIOR_24H_CANDLES]! };
}

function marketWindow(raw: RawMarket): {ticker:string;openTimeMs:number;closeTimeMs:number;yesAskCents:number|null}|null {
  const normalized = normalizeMarket(raw);
  const ticker=normalized["ticker"];
  const open=normalized["open_time"];
  const close=normalized["close_time"];
  const yesAsk=normalized["yes_ask"];
  const openTimeMs=typeof open==="string"?Date.parse(open):NaN;
  const closeTimeMs=typeof close==="string"?Date.parse(close):NaN;
  if(typeof ticker!=="string"||!/^KXETH15M-/.test(ticker)||!Number.isSafeInteger(openTimeMs)||!Number.isSafeInteger(closeTimeMs)) return null;
  return {ticker,openTimeMs,closeTimeMs,yesAskCents:typeof yesAsk==="number"&&Number.isInteger(yesAsk)?yesAsk:null};
}

async function currentMarket(): Promise<RawMarket|null> {
  return kalshiSeriesFetch("KXETH15M",{forceFresh:true});
}

async function fetchMarket(ticker:string):Promise<RawMarket|null>{
  try{
    const r=await kalshiFetch<{market?:RawMarket}>(`/markets/${ticker}`);
    return r.market??null;
  }catch{return null;}
}

async function persistDryRun(input:{
  id:string;sourceOpenTimeMs:number;ticker:string;price:number;contracts:number;principal:number;fee:number;risk:number;payload:unknown;nowMs:number;
}):Promise<"created"|"duplicate"|"blocked">{
  try{
    return await db.transaction(async tx=>{
      const active=await tx.execute(sql`
        SELECT id FROM l_sweep_reclaim_dry_run_intents
        WHERE state IN ('DRY_RUN_READY','SIMULATED_OPEN')
        LIMIT 1
      `);
      if(rowsOf(active).length>0) return "blocked";
      const r=await tx.execute(sql`
        INSERT INTO l_sweep_reclaim_dry_run_intents
          (id,source_open_time_ms,destination_ticker,state,executable_yes_price_cents,contracts,principal_cents,fee_headroom_cents,requested_risk_cents,payload_json,created_at_ms,updated_at_ms)
        VALUES
          (${input.id},${input.sourceOpenTimeMs},${input.ticker},'DRY_RUN_READY',${input.price},${input.contracts},${input.principal},${input.fee},${input.risk},${JSON.stringify(input.payload)}::jsonb,${input.nowMs},${input.nowMs})
        ON CONFLICT (id) DO NOTHING
        RETURNING id
      `);
      return rowsOf(r).length===1?"created":"duplicate";
    });
  }catch{return "blocked";}
}

async function settleOpen(nowMs:number):Promise<void>{
  const open=await db.execute(sql`
    SELECT * FROM l_sweep_reclaim_dry_run_intents
    WHERE state IN ('DRY_RUN_READY','SIMULATED_OPEN')
    ORDER BY created_at_ms ASC
  `);
  for(const row of rowsOf(open)){
    const ticker=String(row["destination_ticker"]??"");
    if(!ticker) continue;
    const market=await fetchMarket(ticker);
    if(!market) continue;
    const result=normalizeMarket(market)["result"];
    if(result!=="yes"&&result!=="no") continue;
    const contracts=Number(row["contracts"]??0);
    const principal=Number(row["principal_cents"]??0);
    const fee=Number(row["fee_headroom_cents"]??0);
    const pnl=result==="yes"?contracts*100-principal-fee:-(principal+fee);
    await db.execute(sql`
      UPDATE l_sweep_reclaim_dry_run_intents
      SET state='SETTLED',settlement_result=${result},simulated_pnl_cents=${pnl},updated_at_ms=${nowMs}
      WHERE id=${String(row["id"])} AND state IN ('DRY_RUN_READY','SIMULATED_OPEN')
    `);
  }
}

export async function runLSweepReclaimDryRunOnce(
  nowMs=Date.now(),
  recordEvaluation:(input:ShadowEvaluationEventInput)=>Promise<boolean>=recordShadowEvaluation,
):Promise<{outcome:string;ticker:string|null}>{
  const observe=(event:Omit<ShadowEvaluationEventInput,"service"|"evaluationIntervalMs">):void=>{
    void recordEvaluation({
      service:"L",
      evaluationIntervalMs:L_DRY_RUN_POLL_MS,
      ...event,
    }).catch(err=>logger.warn({err,service:"L",decision:event.decision},"L evaluator telemetry call failed"));
  };
  await settleOpen(nowMs);
  const config=loadSweepReclaimRuntimeConfig();
  if(!config.enabled||!config.activationReady) {
    observe({evaluatedAtMs:nowMs,ticker:null,marketOpenTimeMs:null,decision:"error",primaryReason:"disabled_or_unconfigured",wouldSubmit:false,evidence:null});
    return {outcome:"disabled_or_unconfigured",ticker:null};
  }

  const raw=await currentMarket();
  if(!raw) {
    observe({evaluatedAtMs:nowMs,ticker:null,marketOpenTimeMs:null,decision:"error",primaryReason:"market_unavailable",wouldSubmit:false,evidence:null});
    return {outcome:"market_unavailable",ticker:null};
  }
  const dest=marketWindow(raw);
  if(!dest) {
    observe({evaluatedAtMs:nowMs,ticker:null,marketOpenTimeMs:null,decision:"error",primaryReason:"destination_invalid",wouldSubmit:false,evidence:null});
    return {outcome:"destination_invalid",ticker:null};
  }
  const sourceOpenTimeMs=dest.openTimeMs-ETH_15M_MS;
  const history=await fetchEthHistory(sourceOpenTimeMs,nowMs);
  if(!history) {
    observe({evaluatedAtMs:nowMs,ticker:dest.ticker,marketOpenTimeMs:dest.openTimeMs,decision:"error",primaryReason:"source_unavailable",wouldSubmit:false,evidence:null});
    return {outcome:"source_unavailable",ticker:dest.ticker};
  }

  const decision=evaluateSweepReclaimV1(history.source,history.prior96);
  if(!decision.qualifies) {
    observe({evaluatedAtMs:nowMs,ticker:dest.ticker,marketOpenTimeMs:dest.openTimeMs,decision:"no_signal",primaryReason:decision.reason,wouldSubmit:false,evidence:decision.evidence??null});
    logger.info({strategy:"L",ticker:dest.ticker,outcome:"no_signal",reason:decision.reason,evidence:decision.evidence??null},"L sweep/reclaim dry-run evaluation");
    return {outcome:"no_signal",ticker:dest.ticker};
  }
  if(!isImmediateFollowingEth15mWindow(history.source,dest.openTimeMs,dest.closeTimeMs)) {
    observe({evaluatedAtMs:nowMs,ticker:dest.ticker,marketOpenTimeMs:dest.openTimeMs,decision:"qualified",primaryReason:"not_immediate_following_window",wouldSubmit:false,evidence:decision.evidence});
    return {outcome:"not_immediate_following_window",ticker:dest.ticker};
  }
  if(dest.closeTimeMs-nowMs < (config.minimumSecondsRemaining??0)*1000) {
    observe({evaluatedAtMs:nowMs,ticker:dest.ticker,marketOpenTimeMs:dest.openTimeMs,decision:"qualified",primaryReason:"too_late",wouldSubmit:false,evidence:decision.evidence});
    return {outcome:"too_late",ticker:dest.ticker};
  }

  const firstPrice=dest.yesAskCents;
  if(firstPrice==null) {
    observe({evaluatedAtMs:nowMs,ticker:dest.ticker,marketOpenTimeMs:dest.openTimeMs,decision:"qualified",primaryReason:"price_unavailable",wouldSubmit:false,evidence:decision.evidence});
    return {outcome:"price_unavailable",ticker:dest.ticker};
  }
  if(firstPrice>(config.maxEntryPriceCents??0)) {
    observe({evaluatedAtMs:nowMs,ticker:dest.ticker,marketOpenTimeMs:dest.openTimeMs,decision:"qualified",primaryReason:"price_cap_blocked",wouldSubmit:false,evidence:{...decision.evidence,firstPrice,maxEntryPriceCents:config.maxEntryPriceCents}});
    return {outcome:"price_cap_blocked",ticker:dest.ticker};
  }

  const freshRaw=await fetchMarket(dest.ticker);
  const fresh=freshRaw?marketWindow(freshRaw):null;
  const price=fresh?.yesAskCents??null;
  if(price==null) {
    observe({evaluatedAtMs:nowMs,ticker:dest.ticker,marketOpenTimeMs:dest.openTimeMs,decision:"qualified",primaryReason:"final_price_unavailable",wouldSubmit:false,evidence:decision.evidence});
    return {outcome:"final_price_unavailable",ticker:dest.ticker};
  }
  if(price>(config.maxEntryPriceCents??0)) {
    observe({evaluatedAtMs:nowMs,ticker:dest.ticker,marketOpenTimeMs:dest.openTimeMs,decision:"qualified",primaryReason:"final_price_cap_blocked",wouldSubmit:false,evidence:{...decision.evidence,price,maxEntryPriceCents:config.maxEntryPriceCents}});
    return {outcome:"final_price_cap_blocked",ticker:dest.ticker};
  }

  const size=buildLDryRunOrderSize(config.stakeCents??0,config.maxEntryPriceCents??0);
  if(!size) {
    observe({evaluatedAtMs:nowMs,ticker:dest.ticker,marketOpenTimeMs:dest.openTimeMs,decision:"qualified",primaryReason:"invalid_size",wouldSubmit:false,evidence:decision.evidence});
    return {outcome:"invalid_size",ticker:dest.ticker};
  }
  if(size.requestedRiskCents>(config.sharedCorrelatedExposureCapCents??0)) {
    observe({evaluatedAtMs:nowMs,ticker:dest.ticker,marketOpenTimeMs:dest.openTimeMs,decision:"qualified",primaryReason:"shared_cap_blocked",wouldSubmit:false,evidence:{...decision.evidence,requestedRiskCents:size.requestedRiskCents,capCents:config.sharedCorrelatedExposureCapCents}});
    return {outcome:"shared_cap_blocked",ticker:dest.ticker};
  }

  const id=deterministicId(history.source.openTimeMs,dest.ticker);
  const payload={
    ticker:dest.ticker,
    client_order_id:id,
    type:"limit",
    action:"buy",
    side:"yes",
    count:size.contracts,
    yes_price:config.maxEntryPriceCents,
    time_in_force:"good_till_canceled",
  };
  const persisted=await persistDryRun({
    id,sourceOpenTimeMs:history.source.openTimeMs,ticker:dest.ticker,price,contracts:size.contracts,
    principal:size.maxPrincipalCents,fee:size.feeHeadroomCents,risk:size.requestedRiskCents,payload,nowMs,
  });
  const receipt={
    mode:"dry_run",
    submission_performed:false,
    would_submit:persisted==="created"||persisted==="duplicate",
    blockers:persisted==="blocked"?["active_exposure_limit"]:[],
    order_payload:payload,
    intent_id:id,
  };
  observe({
    evaluatedAtMs:nowMs,
    ticker:dest.ticker,
    marketOpenTimeMs:dest.openTimeMs,
    decision:"qualified",
    primaryReason:persisted==="blocked"?"active_exposure_limit":null,
    wouldSubmit:receipt.would_submit,
    evidence:decision.evidence,
  });
  logger.info({strategy:"L",ticker:dest.ticker,outcome:persisted,signal:true,evidence:decision.evidence,executionReceipt:receipt},"L sweep/reclaim dry-run evaluation");
  return {outcome:persisted,ticker:dest.ticker};
}

export function startLSweepReclaimDryRunRuntime():()=>void{
  let inFlight=false;
  const run=()=>{
    if(inFlight)return;
    inFlight=true;
    void runLSweepReclaimDryRunOnce().catch(err=>logger.warn({err},"L sweep/reclaim dry-run iteration failed")).finally(()=>{inFlight=false;});
  };
  run();
  const timer=setInterval(run,L_DRY_RUN_POLL_MS);
  timer.unref();
  return ()=>clearInterval(timer);
}
