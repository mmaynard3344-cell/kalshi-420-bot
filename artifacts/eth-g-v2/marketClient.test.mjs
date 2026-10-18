import test from "node:test";
import assert from "node:assert/strict";
import {ethCurrentTicker,readLastThreeEthSettlements,readEthWindow} from "./marketClient.mjs";
const now=Date.parse("2026-10-18T19:16:00Z");
test("ETH Kalshi ticker uses New York closing clock exactly",()=>{
 assert.equal(ethCurrentTicker(now),"KXETH15M-26OCT181530-30");
});
test("three settled contracts are selected by close, not early listing open",async()=>{
 const data=[];
 const mock=async(url)=>{
  const ticker=decodeURIComponent(url.split("/").at(-1));
  const closeMinute=Number(ticker.match(/-(\d{2})$/)?.[1]??0);
  const close=new Date(Date.parse("2026-10-18T19:00:00Z")+(closeMinute===45?-15:closeMinute===0?0:closeMinute)*60000);
  data.push(ticker);
  const expectedClose=ticker.endsWith("1515-15")?"2026-10-18T19:15:00.000Z":ticker.endsWith("1500-00")?"2026-10-18T19:00:00.000Z":"2026-10-18T18:45:00.000Z";
  return {ok:true,json:async()=>({market:{ticker,status:"settled",result:"yes",open_time:"2026-10-18T10:00:00Z",close_time:expectedClose}})};
 };
 const result=await readLastThreeEthSettlements(Date.parse("2026-10-18T19:15:00Z"),mock);
 assert.equal(result?.length,3);assert.equal(data.length,3);
});
test("rejects unfinalized ETH settlement",async()=>{
 const mock=async url=>({ok:true,json:async()=>({market:{ticker:url.split("/").at(-1),status:"active",result:"yes",close_time:"2026-10-18T19:00:00Z"}})});
 assert.equal(await readLastThreeEthSettlements(Date.parse("2026-10-18T19:15:00Z"),mock),null);
});
test("read-only current ETH exact ticker",async()=>{
 const r=await readEthWindow({nowMs:now,fetcher:async url=>({ok:true,json:async()=>({market:{ticker:url.split("/").at(-1)}})})});
 assert.equal(r.ticker,"KXETH15M-26OCT181530-30");
});
