import assert from "node:assert/strict";
import test from "node:test";
import { reconcileLSweepReclaimOrders, type LRecoveryDeps } from "./sweepReclaimLiveRecovery.js";

function harness(status="executed", filled="2.00", result="yes") {
  const writes:any[]=[],releases:any[]=[],paths:string[]=[];
  const deps:LRecoveryDeps={rows:async()=>[{id:"claim",clientOrderId:"claim",ticker:"KXETH15M-TEST",side:"yes",kalshiOrderId:"order",exchangeIndex:2}],
    read:async<T>(_method:string,path:string):Promise<T>=>{paths.push(path);
      if(path.startsWith("/portfolio/orders/"))return {order:{order_id:"order",client_order_id:"claim",ticker:"KXETH15M-TEST",status,fill_count_fp:filled}} as T;
      if(path.startsWith("/portfolio/fills"))return {fills:[{fill_id:"fill",order_id:"order",ticker:"KXETH15M-TEST",side:"yes",action:"buy",count_fp:filled,yes_price_dollars:"0.75",fee_cost_dollars:"0.03"}]} as T;
      return {market:{ticker:"KXETH15M-TEST",result}} as T;
    },update:async i=>{writes.push(i);return true;},release:async i=>{releases.push(i);return true;}};
  return {deps,writes,releases,paths};
}
test("authoritative fills and YES settlement record economics then release risk",async()=>{
  const h=harness();await reconcileLSweepReclaimOrders(h.deps);assert.equal(h.writes[0].realizedPnlCents,47);
  assert.equal(h.releases[0].to,"settled");assert.ok(h.paths.filter(p=>p.startsWith("/portfolio/")).every(p=>p.includes("exchange_index=2")));
});
test("NO settlement records principal and actual fee loss",async()=>{
  const h=harness("executed","2.00","no");await reconcileLSweepReclaimOrders(h.deps);assert.equal(h.writes[0].realizedPnlCents,-153);
});
test("terminal zero fill is neutral and releases capacity",async()=>{
  const h=harness("canceled","0.00");await reconcileLSweepReclaimOrders(h.deps);assert.equal(h.writes[0].realizedPnlCents,0);assert.equal(h.releases[0].to,"released");
});
test("resting partial fill and absent settlement retain full reservation",async()=>{
  for(const h of [harness("resting"),harness("executed","2.00","")]){await reconcileLSweepReclaimOrders(h.deps);assert.equal(h.releases.length,0);assert.equal(h.writes.length,0);}
});
test("wrong order identity and storage failure retain reservation",async()=>{
  const h=harness();h.deps.read=async<T>()=>({order:{order_id:"order",client_order_id:"another",ticker:"KXETH15M-TEST",status:"executed",fill_count_fp:"2.00"}} as T);
  await reconcileLSweepReclaimOrders(h.deps);assert.equal(h.releases.length,0);
  const s=harness();s.deps.update=async()=>false;await reconcileLSweepReclaimOrders(s.deps);assert.equal(s.releases.length,0);
});
