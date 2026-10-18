import test from "node:test";import assert from "node:assert/strict";
import {runAssetGOnce,quoteAssetG} from "./multiAssetGEngine.mjs";
import {currentTicker} from "./multiAssetGMarket.mjs";
const nowMs=Date.UTC(2026,9,18,21,1);
function markets(asset){
 const closing=Math.floor(nowMs/900000)*900000+900000;
 const previous=[3,2,1].map(n=>currentTicker(asset,closing-n*900000-1));
 return async url=>{
  const ticker=decodeURIComponent(url.split("/").at(-1));
  const active=ticker===currentTicker(asset,nowMs),i=previous.indexOf(ticker);
  if(!active&&i<0)throw Error("unknown_ticker");
  return {ok:true,json:async()=>({market:{ticker,status:active?"active":"settled",
  result:active?"":["no","yes","yes"][i],yes_ask:50,no_ask:50,
  floor_strike:100,open_time:new Date(closing-900000).toISOString(),
  close_time:new Date(closing).toISOString()}})};
 };
}
test("all three G strategies can shadow independently with zero DB writes and POSTs",async()=>{
 for(const asset of ["SOL","XRP","DOGE"]){
  let mutations=0,posts=0;
  const pool={query:async(sql)=>{if(!sql.startsWith("SELECT"))mutations++;return {rows:[{asset,step:0,pending_order_id:null}]}}};
  const result=await runAssetGOnce({asset,pool,nowMs,fetcher:markets(asset),liveEnabled:true,
    authJson:async()=>{posts++;throw Error("no_live_orders")}});
  assert.equal(result.status,"shadow_ready");assert.equal(result.side,"no");
  assert.equal(mutations,0);assert.equal(posts,0);
 }
});
test("missing authenticated recovery holds a pending order and never opens another",async()=>{
 const pool={query:async()=>({rows:[{asset:"SOL",step:2,pending_order_id:"old",
 client_order_id:"old",ticker:"KXSOL15M-TEST",side:"no",exchange_order_id:null,verified_filled_contracts:0}]})};
 const r=await runAssetGOnce({asset:"SOL",pool,nowMs,fetcher:async()=>{throw Error("must_not_fetch")}});
 assert.equal(r.status,"held");assert.equal(r.reason,"authenticated_recovery_unavailable");
});
test("quote normalizes cents and dollars without returning invalid values",()=>{
 assert.equal(quoteAssetG({yes_ask_dollars:"0.43"},"yes"),43);
 assert.equal(quoteAssetG({no_ask:52},"no"),52);
 assert.equal(quoteAssetG({yes_ask:100},"yes"),null);
});
