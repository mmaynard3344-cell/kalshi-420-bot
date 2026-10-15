import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import {readFile} from "node:fs/promises";
import {reserveBtcWager,recordBtcFilled,recordBtcVerifiedSettlement,recordBtcVerifiedZeroFill} from "./btcSharedLadderStore.mjs";
import {applyBtcSettlementEvidence} from "./btcSettlementWriter.mjs";
const url=process.env.BTC_TEST_DATABASE_URL;
if(!url)throw Error("BTC_TEST_DATABASE_URL must target a disposable PostgreSQL instance");
const pool=new pg.Pool({connectionString:url});
const schema=await readFile(new URL("./btcSharedLadder.sql",import.meta.url),"utf8");
await pool.query(schema);
async function reset(){
 await pool.query("TRUNCATE btc_shared_ladder_events RESTART IDENTITY");
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
test.after(async()=>{await pool.end()});
