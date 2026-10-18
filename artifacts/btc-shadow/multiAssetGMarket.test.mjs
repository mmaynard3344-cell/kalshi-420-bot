import test from "node:test";
import assert from "node:assert/strict";
import {currentTicker,inspectGMarket} from "./multiAssetGMarket.mjs";
test("constructs exchange market tickers for all additional assets",()=>{
  const now=Date.parse("2026-10-18T18:20:00Z");
  assert.equal(currentTicker("SOL",now),"KXSOL15M-26OCT181430-30");
  assert.equal(currentTicker("XRP",now),"KXXRP15M-26OCT181430-30");
  assert.equal(currentTicker("DOGE",now),"KXDOGE15M-26OCT181430-30");
});
test("only validates the requested Kalshi asset; never executes orders",async()=>{
 const now=Date.parse("2026-10-18T18:20:00Z");
 const fetcher=async url=>({ok:true,json:async()=>({market:{
   ticker:url.split("/").at(-1),status:"active",open_time:"2026-10-18T18:15:00Z",
   close_time:"2026-10-18T18:30:00Z",floor_strike:123.5
 }})});
 for (const asset of ["SOL","XRP","DOGE"]){const r=await inspectGMarket(asset,now,fetcher);assert.equal(r.status,"ready");assert.equal(r.market.asset,asset)}
});
test("missing contracts and invalid response fail closed",async()=>{
 const now=Date.parse("2026-10-18T18:20:00Z");
 assert.equal((await inspectGMarket("SOL",now,async()=>({ok:false,status:404}))).status,"unavailable");
 assert.equal((await inspectGMarket("XRP",now,async()=>({ok:true,json:async()=>({market:{}})}))).status,"unavailable");
});
