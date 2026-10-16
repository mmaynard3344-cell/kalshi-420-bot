import assert from "node:assert/strict";
import {build} from "esbuild";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {pathToFileURL} from "node:url";
const dir=await mkdtemp(join(tmpdir(),"eth-b-lifecycle-"));
try{
 const out=join(dir,"lifecycle.mjs");
 await build({entryPoints:[resolve("src/lib/strategies/ethJumpSharedLifecycle.ts")],bundle:true,platform:"node",format:"esm",outfile:out,
  plugins:[{name:"mock-reader",setup(b){
   b.onResolve({filter:/ethJumpSharedKalshiReconciler/},()=>({path:"reader",namespace:"mock"}));
   b.onLoad({filter:/.*/,namespace:"mock"},()=>({loader:"js",contents:"export const reconcileBFromKalshi = async (x) => globalThis.__testBRead(x);"}));
  }}]});
 const {reconcilePendingBSharedOrders}=await import(pathToFileURL(out).href);
 const base={claimId:"claim",clientOrderId:"client",exchangeOrderId:"order",ticker:"KXETH15M-TEST",side:"yes"};
 const observed=[];
 globalThis.__testBRead=async x=>{observed.push(x);if(x.claimId==="error")throw Error("temporary network failure");return x.claimId==="done"?"FINALIZED":"PENDING";};
 const result=await reconcilePendingBSharedOrders({listPending:async()=>[
  {...base,claimId:"done"},{...base,claimId:"pending"},{...base,claimId:"error"},
  {...base,claimId:"",exchangeOrderId:"missing"},{...base,ticker:"KXBTC15M-TEST"}
 ]});
 assert.deepEqual(result,{finalized:1,pending:3,errors:1});
 assert.equal(observed.length,3);
 console.log("PASS: B lifecycle reconciles verified claims, holds incomplete identities, and fails closed on read errors");
}finally{await rm(dir,{recursive:true,force:true});}
