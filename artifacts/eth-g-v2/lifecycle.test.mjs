import test from "node:test";
import assert from "node:assert/strict";
import {runEthGLifecycle} from "./lifecycle.mjs";
const evaluation={status:"ready",side:"yes",ticker:"KXETH15M-26OCT181530-30",step:0,triggerKey:"a|b"};
test("live switch default-off does not call exchange",async()=>{
 let exchanges=0;
 const pool={query:async()=>({rows:[{step:0,pending_client_order_id:null}]})};
 const r=await runEthGLifecycle({pool,evaluation,askCents:50,
 authJson:async()=>{exchanges++;throw Error("unexpected exchange read")},
 marketJson:async()=>{exchanges++;throw Error("unexpected market read")}});
 assert.equal(r.status,"shadow");assert.equal(exchanges,0);
});
test("pending reservation takes priority over any new signal",async()=>{
 const pool={query:async()=>({rows:[{step:2,pending_client_order_id:"old-id",ticker:"KXETH15M-26OCT181500-00",side:"no",exchange_order_id:null,verified_filled_contracts:0}]})};
 const r=await runEthGLifecycle({pool,evaluation,askCents:50,authJson:async()=>({orders:[]}),marketJson:async()=>({})});
 assert.equal(r.status,"recovery");assert.equal(r.reason,"order_absent_unverified");
});
test("caller cannot activate live orders without the explicit environment gate",async()=>{
 const pool={query:async()=>({rows:[{step:0,pending_client_order_id:null}]})};
 const r=await runEthGLifecycle({pool,evaluation,askCents:50,liveEnabled:true,
 authJson:async()=>{throw Error("unexpected")},marketJson:async()=>({})});
 assert.equal(r.status,"shadow");
});
