import test from "node:test";
import assert from "node:assert/strict";
import { recoverPendingEthG } from "./recoveryCoordinator.mjs";
test("ETH G v2 recovery has no side effects without a pending reservation",async()=>{
 const queries=[];
 const pool={query:async(sql)=>{queries.push(sql);return {rows:[{step:0,pending_client_order_id:null}]}}};
 const result=await recoverPendingEthG({pool,authJson:async()=>{throw Error("unexpected auth read")},
 marketJson:async()=>{throw Error("unexpected market read")}});
 assert.deepEqual(result,{state:"idle"});assert.equal(queries.length,1);
});
