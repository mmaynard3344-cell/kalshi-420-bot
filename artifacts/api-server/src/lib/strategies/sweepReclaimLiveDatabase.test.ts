import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { claimSweepReclaimSignal, getSweepReclaimClaim, initTradeStore, updateSweepReclaimClaim } from "../tradeStore.js";
import { runLSweepReclaimLiveOnce, lLiveClaimId, type LLiveRuntimeDeps } from "./sweepReclaimLiveRuntime.js";
import { executeSweepReclaimV1, _setSweepReclaimExecutionDepsForTesting } from "./sweepReclaimExecutionAdapter.js";
import { reconcileLSweepReclaimOrders } from "./sweepReclaimLiveRecovery.js";
import { transitionProductionEthLongReversalBySourceOrderId } from "./ethLongReversalExposure.js";
import { ETH_15M_MS } from "./sweepReclaimV1.js";

const sourceOpen = Date.UTC(1976,0,2);
const ticker = "KXETH15M-L-DB-VERIFICATION";
const id = lLiveClaimId(sourceOpen,ticker);
async function cleanup() {
  await db.execute(sql`DELETE FROM eth_long_reversal_reservations WHERE source_order_id=${id}`);
  await db.execute(sql`DELETE FROM sweep_reclaim_claims WHERE id=${id}`);
}
before(async()=>{
  const url = new URL(process.env.DATABASE_URL!);
  assert.ok(["127.0.0.1","localhost"].includes(url.hostname),"L database test requires a disposable localhost database");
  await initTradeStore(); await cleanup();
});
after(async()=>{_setSweepReclaimExecutionDepsForTesting({});await cleanup();});

test("two live workers share a permanent database claim, submit once, and settle actual economics",async()=>{
  let posts=0;
  _setSweepReclaimExecutionDepsForTesting({submitGuard:async()=>true,
    priceReader:async()=>({lowestLevelCents:75,error:null} as any),
    exchange:{submit:async input=>{assert.equal(input.contracts,66);assert.equal(input.limitPriceCents,75);
      posts++;return {kind:"accepted",exchangeOrderId:"db-verified-order"};}}});
  const source={openTimeMs:sourceOpen,closeTimeMs:sourceOpen+ETH_15M_MS,open:103,high:106,low:99,close:104,finalized:true};
  const prior96=Array.from({length:96},(_,i)=>({openTimeMs:sourceOpen-(96-i)*ETH_15M_MS,
    closeTimeMs:sourceOpen-(95-i)*ETH_15M_MS,open:105,high:110,low:100,close:106,finalized:true}));
  // The destination deadline is supplied by this fixture. The mock executor
  // uses the fixture clock while retaining the real DB admission/write path.
  const deps:LLiveRuntimeDeps={config:()=>({enabled:true,liveExecutionEnabled:true,activationReady:true,
    stakeCents:5000,maxEntryPriceCents:75,sharedCorrelatedExposureCapCents:5200,minimumSecondsRemaining:120,
    orderType:"good_till_canceled",unresolved:[]}),permitted:()=>true,reconcile:async()=>{},
    currentMarket:async()=>({ticker,status:"active",exchange_index:2,open_time:new Date(source.closeTimeMs).toISOString(),
      close_time:new Date(source.closeTimeMs+ETH_15M_MS).toISOString()}),history:async()=>({source,prior96}),
    claim:claimSweepReclaimSignal,execute:input=>executeSweepReclaimV1({...input,nowMs:source.closeTimeMs+1000})};
  const outcomes=await Promise.all([runLSweepReclaimLiveOnce(source.closeTimeMs+1000,deps),runLSweepReclaimLiveOnce(source.closeTimeMs+1000,deps)]);
  assert.ok(outcomes.includes("submitted"));assert.equal(posts,1);
  const claim=await getSweepReclaimClaim(id);assert.equal(claim?.lifecycleState,"SUBMITTED");assert.equal(claim?.requestedRiskCents,5037);
  const reservations=await db.execute(sql`SELECT active_risk_cents,state FROM eth_long_reversal_reservations WHERE source_order_id=${id}`);
  assert.equal(reservations.rows[0]?.active_risk_cents,5037);assert.equal(reservations.rows[0]?.state,"submitted");
  await reconcileLSweepReclaimOrders({rows:async()=>[{id,clientOrderId:id,ticker,side:"yes",kalshiOrderId:"db-verified-order",exchangeIndex:2}],
    read:async<T>(_method:string,path:string):Promise<T>=>{
      if(path.startsWith("/portfolio/orders/"))return {order:{order_id:"db-verified-order",client_order_id:id,ticker,status:"executed",fill_count_fp:"66.00"}} as T;
      if(path.startsWith("/portfolio/fills"))return {fills:[{fill_id:"verified-fill",order_id:"db-verified-order",ticker,side:"yes",action:"buy",count_fp:"66.00",yes_price_dollars:"0.75",fee_cost:"0.87"}]} as T;
      return {market:{ticker,result:"yes"}} as T;
    },update:updateSweepReclaimClaim,release:transitionProductionEthLongReversalBySourceOrderId});
  const settled=await getSweepReclaimClaim(id);assert.equal(settled?.lifecycleState,"SETTLED");assert.equal(settled?.realizedPnlCents,1563);
  const released=await db.execute(sql`SELECT state FROM eth_long_reversal_reservations WHERE source_order_id=${id}`);
  assert.equal(released.rows[0]?.state,"settled");
});
