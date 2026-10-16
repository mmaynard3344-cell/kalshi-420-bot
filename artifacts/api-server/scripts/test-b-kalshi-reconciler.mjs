import assert from "node:assert/strict";
import {build} from "esbuild";
import {mkdtemp,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {pathToFileURL} from "node:url";
const temp=await mkdtemp(join(tmpdir(),"b-kalshi-test-"));
try {
 const outfile=join(temp,"reconciler.mjs");
 await build({entryPoints:[resolve("src/lib/strategies/ethJumpSharedKalshiReconciler.ts")],
  platform:"node",format:"esm",bundle:true,outfile,
  plugins:[{name:"mock-kalshi",setup(b){
    b.onResolve({filter:/kalshiAuth\\.js$|kalshi\\.js$|ethJumpSharedSettlement\\.js$/},args=>({path:args.path,namespace:"mock"}));
    b.onLoad({filter:/.*/,namespace:"mock"},args=>{
      if(args.path.endsWith("kalshiAuth.js"))return {contents:"export const kalshiAuthFetch = async (...args) => globalThis.__bMock.auth(...args);",loader:"js"};
      if(args.path.endsWith("kalshi.js"))return {contents:"export const kalshiFetch = async (...args) => globalThis.__bMock.market(...args);",loader:"js"};
      return {contents:"export const reconcileBSharedTerminal = async (...args) => globalThis.__bMock.finalize(...args);",loader:"js"};
    });
  }}]});
 const {reconcileBFromKalshi}=await import(pathToFileURL(outfile).href);
 const input={claimId:"test-claim",clientOrderId:"b-client",ticker:"KXETH15M-26OCT161515-15",side:"no",exchangeOrderId:"exchange-1"};
 const base={order_id:"exchange-1",client_order_id:"b-client",ticker:input.ticker,status:"executed",fill_count:2};
 let order=base,market={market:{result:"yes"}},finalized=[];
 globalThis.__bMock={auth:async()=>({order}),market:async()=>market,finalize:async(x)=>{finalized.push(x);return "FINALIZED";}};
 async function pending(o,m=market){order=o;market=m;finalized=[];assert.equal(await reconcileBFromKalshi(input),"PENDING");assert.equal(finalized.length,0);}
 await pending({...base,client_order_id:"wrong"});
 await pending({...base,order_id:"wrong"});
 await pending({...base,ticker:"wrong"});
 await pending({...base,status:"resting"});
 await pending({...base,fill_count:undefined});
 await pending({...base,fill_count:"bad"});
 await pending({...base,fill_count:2},{market:{result:null}});
 order={...base,fill_count:"2"};market={market:{result:"yes"}};finalized=[];
 assert.equal(await reconcileBFromKalshi(input),"FINALIZED");
 assert.equal(finalized[0].finalFillCount,2);assert.equal(finalized[0].marketResult,"yes");
 assert.equal(finalized[0].settlementId,"B:exchange-1:yes");
 order={...base,status:"canceled",fill_count:0};market={market:{result:null}};finalized=[];
 assert.equal(await reconcileBFromKalshi(input),"FINALIZED");
 assert.equal(finalized[0].finalFillCount,0);
 console.log("PASS: authenticated B reader blocks identity/status/fill/result ambiguity and handles partial-fill and zero-fill");
}finally{await rm(temp,{recursive:true,force:true});}
