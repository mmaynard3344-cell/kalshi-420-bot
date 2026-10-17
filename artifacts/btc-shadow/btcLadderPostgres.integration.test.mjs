import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import {readFile} from "node:fs/promises";
import {reserveBtcWager,recordBtcFilled,recordBtcVerifiedSettlement,recordBtcVerifiedZeroFill,reserveBtcWagerWithIdentity,attachBtcExchangeOrderId,loadBtcPendingIdentity} from "./btcSharedLadderStore.mjs";
import {applyBtcSettlementEvidence} from "./btcSettlementWriter.mjs";
import {reconcilePendingBtcOrder} from "./btcAuthenticatedRecovery.mjs";
const url=process.env.BTC_TEST_DATABASE_URL;
if(!url)throw Error("BTC_TEST_DATABASE_URL must target a disposable PostgreSQL instance");
const pool=new pg.Pool({connectionString:url});
const schema=await readFile(new URL("./btcSharedLadder.sql",import.meta.url),"utf8");
await pool.query(schema);
async function reset(){
 await pool.query("TRUNCATE btc_shared_ladder_events,btc_ladder_order_identity RESTART IDENTITY");
 await pool.query("UPDATE btc_shared_ladder SET step=0,pending_order_id=NULL,pending_settlement_id=NULL,last_settlement_id=NULL,version=0 WHERE market='BTC'");
}
const reservation={clientOrderId:"btc-ci-1",ticker:"KXBTC15M-EXAMPLE",side:"yes"};
test("real PostgreSQL: verified loss, duplicate replay, restart persistence, and win reset",async()=>{
 await reset();
 assert.equal((await reserveBtcWager(pool,reservation.clientOrderId)).stakeCents,100);
 await assert.rejects(()=>reserveBtcWager(pool,"btc-ci-blocked"),/busy/);
 const order={client_order_id:reservation.clientOrderId,order_id:"exchange-ci-1",ticker:reservation.ticker,status:"executed",fill_count_fp:2};
 const payload={pool,reservation,order,fills:[{order_id:"exchange-ci-1",count_fp:2}],market:{ticker:reservation.ticker,result:"no"}};
 const loss=await applyBtcSettlementEvidence(payload);
 assert.equal(loss.step,1);
 assert.equal((await applyBtcSettlementEvidence(payload)).applied,false);
 const saved=await pool.query("SELECT step,pending_order_id,pending_settlement_id FROM btc_shared_ladder WHERE market='BTC'");
 assert.equal(saved.rows[0].step,1);
 assert.equal(saved.rows[0].pending_order_id,null);
 assert.equal((await reserveBtcWager(pool,"btc-ci-2")).stakeCents,200);
 await recordBtcFilled(pool,"btc-ci-2","btc-ci-2");
 assert.equal((await recordBtcVerifiedSettlement(pool,"btc-ci-2","WIN")).step,0);
});
test("real PostgreSQL: verified zero fill does not advance ladder",async()=>{
 await reset();
 await reserveBtcWager(pool,"btc-ci-zero");
 await recordBtcVerifiedZeroFill(pool,"btc-ci-zero");
 const r=await pool.query("SELECT step,pending_order_id FROM btc_shared_ladder WHERE market='BTC'");
 assert.equal(r.rows[0].step,0);
 assert.equal(r.rows[0].pending_order_id,null);
});
test("real PostgreSQL: pending order identity survives new connection and blocks conflicting exchange id",async()=>{
 await reset();
 await reserveBtcWagerWithIdentity(pool,{clientOrderId:"btc-ci-durable",ticker:"KXBTC15M-EXAMPLE",side:"no"});
 const recovered=await loadBtcPendingIdentity(pool);
 assert.equal(recovered.clientOrderId,"btc-ci-durable");
 assert.equal(recovered.ticker,"KXBTC15M-EXAMPLE");
 assert.equal(recovered.side,"no");
 assert.equal(recovered.exchangeOrderId,null);
 await attachBtcExchangeOrderId(pool,"btc-ci-durable","exchange-ci-durable");
 assert.equal((await loadBtcPendingIdentity(pool)).exchangeOrderId,"exchange-ci-durable");
 await assert.rejects(()=>attachBtcExchangeOrderId(pool,"btc-ci-durable","other-order"),/conflict/);
 await assert.rejects(()=>reserveBtcWagerWithIdentity(pool,{clientOrderId:"btc-ci-next",ticker:"KXBTC15M-EXAMPLE",side:"yes"}),/busy/);
});
test("real PostgreSQL: authenticated pending BTC order settles after recovery and is exactly once",async()=>{
 await reset();
 const ticker="KXBTC15M-EXAMPLE";
 await reserveBtcWagerWithIdentity(pool,{clientOrderId:"btc-ci-auth",ticker,side:"yes"});
 await attachBtcExchangeOrderId(pool,"btc-ci-auth","exchange-ci-auth");
 const requests=[];
 const args={pool,publicBase:"https://example.test",authJson:async(method,path)=>{
  requests.push(path);
  if(path==="/portfolio/orders/exchange-ci-auth")return {order:{order_id:"exchange-ci-auth",client_order_id:"btc-ci-auth",ticker,status:"executed",fill_count_fp:"2"}};
  if(path.startsWith("/portfolio/fills?order_id=exchange-ci-auth"))return {fills:[{order_id:"exchange-ci-auth",count_fp:"2"}],cursor:""};
  throw Error("unexpected request");
 },publicJson:async()=>({market:{ticker,result:"no"}})};
 assert.deepEqual(await reconcilePendingBtcOrder(args),{state:"settled",kind:"LOSS",step:1});
 assert.deepEqual(await reconcilePendingBtcOrder(args),{state:"idle"});
 assert.equal((await pool.query("SELECT step FROM btc_shared_ladder WHERE market='BTC'")).rows[0].step,1);
 assert.equal(requests.length,2);
});
test("real PostgreSQL: lost order acknowledgement recovered by authenticated client id",async()=>{
 await reset();
 const ticker="KXBTC15M-EXAMPLE";
 await reserveBtcWagerWithIdentity(pool,{clientOrderId:"btc-ci-ack",ticker,side:"no"});
 let listHits=0;
 const result=await reconcilePendingBtcOrder({pool,publicBase:"https://example.test",authJson:async(method,path)=>{
  if(path.startsWith("/portfolio/orders?")){listHits++;return {orders:[{client_order_id:"btc-ci-ack",order_id:"exchange-ci-ack",ticker}],cursor:""}}
  if(path==="/portfolio/orders/exchange-ci-ack")return {order:{client_order_id:"btc-ci-ack",order_id:"exchange-ci-ack",ticker,status:"executed",fill_count_fp:"1"}};
  if(path.startsWith("/portfolio/fills?"))return {fills:[{order_id:"exchange-ci-ack",count_fp:"1"}],cursor:""};
  throw Error("unexpected auth path "+path)
 },publicJson:async()=>({market:{ticker,result:"yes"}})});
 assert.equal(result.state,"settled");
 assert.equal(result.kind,"LOSS");
 assert.equal(result.step,1);
 assert.equal(listHits,1);
});
test.after(async()=>{await pool.end()});
