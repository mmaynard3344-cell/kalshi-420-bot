import test from "node:test";
import assert from "node:assert/strict";
import {loadPendingBtcReservation} from "./btcLadderRecovery.mjs";
test("restart recovery preserves uncertain outstanding order",async()=>{
 let released=false;
 const pool={connect:async()=>({query:async()=>({rows:[{step:2,pending_order_id:"order-1",pending_settlement_id:null,version:4}]}),release(){released=true}})};
 assert.deepEqual(await loadPendingBtcReservation(pool),{step:2,orderId:"order-1",settlementId:null,version:4,reconciliationRequired:true});
 assert.equal(released,true);
});
test("missing state fails closed",async()=>{
 const pool={connect:async()=>({query:async()=>({rows:[]}),release(){}})};
 await assert.rejects(()=>loadPendingBtcReservation(pool),/missing/);
});
