import test from "node:test";
import assert from "node:assert/strict";
import {observeOnce} from "./observer.mjs";
test("observer logs a qualifying signal without placing a trade",async()=>{
 const nowMs=Date.parse("2026-10-18T19:16:00Z");
 const results=["no","yes","yes"];
 const logs=[];let calls=0;
 const fetcher=async url=>{
  calls++;
  const ticker=decodeURIComponent(url.split("/").at(-1));
  const mins=Number(ticker.slice(-2));
  const close=ticker.includes("1530")?"2026-10-18T19:30:00Z":ticker.includes("1515")?"2026-10-18T19:15:00Z":ticker.includes("1500")?"2026-10-18T19:00:00Z":"2026-10-18T18:45:00Z";
  const idx=ticker.includes("1445")?0:ticker.includes("1500")?1:2;
  return {ok:true,json:async()=>({market:{ticker,close_time:close,open_time:"2026-10-18T10:00:00Z",status:ticker.includes("1530")?"active":"settled",floor_strike:3200,result:results[idx]}})};
 };
 const r=await observeOnce({nowMs,fetcher,log:x=>logs.push(JSON.parse(x))});
 assert.equal(r.status,"shadow_ready");assert.equal(r.side,"yes");
 assert.equal(logs[0].event,"eth_g_v2_shadow_evaluation");assert.equal(calls,4);
});
test("observer records explicit failure on rejected market HTTP",async()=>{
 const logs=[];
 const r=await observeOnce({nowMs:Date.parse("2026-10-18T19:16:00Z"),
 fetcher:async()=>({ok:false,status:404}),log:x=>logs.push(JSON.parse(x))});
 assert.equal(r.reason,"kalshi_market_read_failed");assert.equal(logs.length,1);
});
