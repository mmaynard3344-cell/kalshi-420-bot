import assert from "node:assert/strict";
import pg from "pg";
import {recoverAssetG} from "./multiAssetGRecovery.mjs";
import {reserveAssetG,recordVerifiedAssetGFill,settleVerifiedAssetG,readAssetG} from "./multiAssetGStore.mjs";
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});
try{
 const first=await Promise.all([
  reserveAssetG(pool,{asset:"SOL",orderId:"sol-test-a",ticker:"KXSOL15M-TEST",side:"no"}),
  reserveAssetG(pool,{asset:"XRP",orderId:"xrp-test-a",ticker:"KXXRP15M-TEST",side:"yes"}),
  reserveAssetG(pool,{asset:"DOGE",orderId:"doge-test-a",ticker:"KXDOGE15M-TEST",side:"yes"})
 ]);
 assert.deepEqual(first.map(x=>x.stakeCents),[200,200,200]);
 await assert.rejects(reserveAssetG(pool,{asset:"SOL",orderId:"sol-duplicate",ticker:"KXSOL15M-TEST2",side:"no"}));
 await recordVerifiedAssetGFill(pool,{asset:"SOL",orderId:"sol-test-a",exchangeOrderId:"exchange-sol",filledContracts:3});
 await settleVerifiedAssetG(pool,{asset:"SOL",orderId:"sol-test-a",settlementId:"settle-sol",result:"loss"});
 const states=await Promise.all(["SOL","XRP","DOGE"].map(asset=>readAssetG(pool,asset)));
 assert.deepEqual(states.map(s=>Number(s.step)),[1,0,0]);
 assert.equal(states[0].pending_order_id,null);
 assert.equal(states[1].pending_order_id,"xrp-test-a");
 assert.equal(states[2].pending_order_id,"doge-test-a");
 await assert.rejects(settleVerifiedAssetG(pool,{asset:"SOL",orderId:"sol-test-a",settlementId:"settle-sol",result:"loss"}));
 const restart=new pg.Pool({connectionString:process.env.DATABASE_URL});
 try {const s=await readAssetG(restart,"SOL");assert.equal(Number(s.step),1);
   const next=await reserveAssetG(restart,{asset:"SOL",orderId:"sol-test-b",ticker:"KXSOL15M-TEST2",side:"yes"});
   assert.equal(next.stakeCents,400);
 }finally{await restart.end()}
 const xrpTicker="KXXRP15M-TEST";
 const authJson=async(_method,path)=>{
  if(path.startsWith("/portfolio/orders?"))return {orders:[{order_id:"ex-xrp",client_order_id:"xrp-test-a",ticker:xrpTicker}]};
  if(path.startsWith("/portfolio/orders/"))return {order:{order_id:"ex-xrp",client_order_id:"xrp-test-a",ticker:xrpTicker,side:"yes",status:"executed"}};
  if(path.startsWith("/portfolio/fills"))return {fills:[{order_id:"ex-xrp",ticker:xrpTicker,count:2}]};
  throw Error("unexpected_exchange_query");
 };
 const reconciliation=await recoverAssetG({pool,asset:"XRP",authJson,
  publicJson:async()=>({market:{ticker:xrpTicker,result:"no"}}),
  publicBase:"https://api.elections.kalshi.com/trade-api/v2"});
 assert.equal(reconciliation.state,"settled");
 const after=await Promise.all(["SOL","XRP","DOGE"].map(a=>readAssetG(pool,a)));
 assert.deepEqual(after.map(x=>Number(x.step)),[1,1,0]);
 assert.equal(after[2].pending_order_id,"doge-test-a");
 console.log("MULTI_ASSET_G_POSTGRES_PASS");
}finally{await pool.end()}
