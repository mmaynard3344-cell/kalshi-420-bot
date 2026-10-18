import assert from "node:assert/strict";
import pg from "pg";
import {reserveEthG,attachVerifiedEthGFill,settleVerifiedEthG,getPendingEthG} from "./store.mjs";
const pool=new pg.Pool();
try{
 const first=await reserveEthG(pool,{clientOrderId:"test-order-1",ticker:"KXETH15M-26OCT181530-30",side:"yes",triggerKey:"older|latest"});
 assert.equal(first.stakeCents,200);
 await assert.rejects(reserveEthG(pool,{clientOrderId:"test-order-2",ticker:"KXETH15M-26OCT181545-45",side:"no",triggerKey:"newer|latest"}),/order_pending/);
 assert.equal((await getPendingEthG(pool)).clientOrderId,"test-order-1");
 await assert.rejects(settleVerifiedEthG(pool,{clientOrderId:"test-order-1",settlementId:"settlement-1",outcome:"loss"}),/verified_fill_missing/);
 await attachVerifiedEthGFill(pool,{clientOrderId:"test-order-1",exchangeOrderId:"exchange-1",filledContracts:3});
 const settled=await settleVerifiedEthG(pool,{clientOrderId:"test-order-1",settlementId:"settlement-1",outcome:"loss"});
 assert.equal(settled.step,1);
 assert.equal(await getPendingEthG(pool),null);
 await assert.rejects(reserveEthG(pool,{clientOrderId:"replay",ticker:"KXETH15M-26OCT181600-00",side:"yes",triggerKey:"older|latest"}),/trigger_replayed/);
 assert.equal((await reserveEthG(pool,{clientOrderId:"test-order-3",ticker:"KXETH15M-26OCT181600-00",side:"no",triggerKey:"latest|newest"})).stakeCents,400);
 console.log("ETH_G_V2_REAL_PG_PASS order reservation, duplicate lock, verified fill, loss progression, trigger replay");
}finally{await pool.end()}
