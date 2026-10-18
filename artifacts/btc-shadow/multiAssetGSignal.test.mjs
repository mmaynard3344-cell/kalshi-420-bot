import test from "node:test";import assert from "node:assert/strict";
import {evaluateAssetG} from "./multiAssetGSignal.mjs";
import {currentTicker} from "./multiAssetGMarket.mjs";
const nowMs=Date.UTC(2026,9,18,21,1);
function mock(asset,outcomes=["no","yes","yes"],invalid=false){
 const closing=Math.floor(nowMs/900000)*900000+900000;
 const prior=[3,2,1].map(n=>currentTicker(asset,closing-n*900000-1));
 const current=currentTicker(asset,nowMs);
 return async url=>{
  const ticker=decodeURIComponent(url.split("/").at(-1));
  const i=prior.indexOf(ticker),isCurrent=ticker===current;
  const market={ticker,status:isCurrent?"active":invalid&&i===1?"active":"settled",
    result:isCurrent?"":outcomes[i],floor_strike:100,
    open_time:new Date(closing-900000).toISOString(),close_time:new Date(closing).toISOString()};
  return {ok:true,json:async()=>({market})};
 };
}
test("SOL buys opposite of newest exact-two YES streak",async()=>{
 const r=await evaluateAssetG({asset:"SOL",nowMs,fetcher:mock("SOL")});
 assert.equal(r.status,"ready");assert.equal(r.side,"no");assert.equal(r.previous.length,3);
});
test("XRP buys opposite of newest exact-two NO streak",async()=>{
 const r=await evaluateAssetG({asset:"XRP",nowMs,fetcher:mock("XRP",["yes","no","no"])});
 assert.equal(r.status,"ready");assert.equal(r.side,"yes");
});
test("DOGE does not fire without exact-two streak",async()=>{
 const r=await evaluateAssetG({asset:"DOGE",nowMs,fetcher:mock("DOGE",["yes","yes","yes"])});
 assert.equal(r.status,"no_signal");
});
test("never treats unfinalized preceding market as a result",async()=>{
 const r=await evaluateAssetG({asset:"SOL",nowMs,fetcher:mock("SOL",["no","yes","yes"],true)});
 assert.equal(r.status,"blocked");assert.equal(r.reason,"previous_market_not_final");
});
