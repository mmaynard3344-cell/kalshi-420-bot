import test from "node:test";
import assert from "node:assert/strict";
import {reserveBtcWager,recordBtcFilled,recordBtcVerifiedSettlement} from "./btcSharedLadderStore.mjs";
function mockDb(){
 const row={step:0,pending_order_id:null,pending_settlement_id:null,last_settlement_id:null,version:0};
 const events=[];
 const calls=[];
 const client={
  async query(q,args=[]){
   calls.push(q);
   if(q.startsWith("SELECT step"))return {rows:[{...row}],rowCount:1};
   if(q.startsWith("UPDATE btc_shared_ladder")){
    if(row.version!==args[5])return {rows:[],rowCount:0};
    [row.step,row.pending_order_id,row.pending_settlement_id,row.last_settlement_id,row.version]=args.slice(0,5);
    return {rowCount:1,rows:[{version:row.version}]};
   }
   if(q.startsWith("INSERT INTO btc_shared_ladder_events")){events.push(args);return {rowCount:1}};
   if(q.startsWith("SELECT 1 FROM btc_shared_ladder_events"))return {rowCount:events.filter(e=>e[2]===args[0]&&["WIN","LOSS"].includes(e[0])).length,rows:[]};
   return {rowCount:0};
  },
  release(){}
 };
 return {pool:{connect:async()=>client},row,events,calls};
}
test("reservation/fill/loss persists advancement; duplicate settlement does not advance",async()=>{
 const db=mockDb();
 assert.equal((await reserveBtcWager(db.pool,"o1")).stakeCents,100);
 await assert.rejects(()=>reserveBtcWager(db.pool,"o2"),/busy/);
 await recordBtcFilled(db.pool,"o1","s1");
 assert.equal((await recordBtcVerifiedSettlement(db.pool,"s1","LOSS")).step,1);
 assert.deepEqual(await recordBtcVerifiedSettlement(db.pool,"s1","LOSS"),{alreadyProcessed:true,step:1});
 assert.equal((await reserveBtcWager(db.pool,"o2")).stakeCents,200);
 assert.equal(db.calls.filter(q=>q==="BEGIN").length,6);
 assert.equal(db.calls.filter(q=>q==="COMMIT").length,5);
});
test("DB errors fail closed and roll back",async()=>{
 const db=mockDb();db.pool.connect=async()=>({query:async q=>{if(q==="BEGIN")return;throw Error("database offline")},release(){}});
 await assert.rejects(()=>reserveBtcWager(db.pool,"o1"),/database offline/);
});
