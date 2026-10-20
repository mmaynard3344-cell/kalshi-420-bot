import assert from "node:assert/strict";
import test from "node:test";
import { decideEthBinarySettlementWithEarlyExits as decide } from "./target75MartingaleSettlementGate.js";
test("normal settlement permitted only when journal is verified empty",()=>{
 assert.deepEqual(decide({authenticatedEntryFills:2,authenticatedEarlyExitFills:0,journalReadConfirmed:true,unresolvedExitAttempt:false}),{action:"normal_binary_settlement",contracts:2});
});
test("early sold ETH lots cannot be double-counted as normal market settlement",()=>{
 const x=decide({authenticatedEntryFills:2,authenticatedEarlyExitFills:1,journalReadConfirmed:true,unresolvedExitAttempt:false});
 assert.equal(x.action,"defer");
});
test("unknown IOC and missing journal access both block settlement",()=>{
 for(const change of [{unresolvedExitAttempt:true},{journalReadConfirmed:false},{authenticatedEarlyExitFills:null}]){
 const x=decide({...{authenticatedEntryFills:2,authenticatedEarlyExitFills:0,journalReadConfirmed:true,unresolvedExitAttempt:false},...change});
 assert.equal(x.action,"defer");
 }
});
