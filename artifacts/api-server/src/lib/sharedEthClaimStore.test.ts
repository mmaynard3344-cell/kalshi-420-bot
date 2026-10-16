import {describe,it} from "node:test";
import assert from "node:assert/strict";
import {claimFirstEthSignal,finalizeEthClaim,type QueryClient,type TransactionProvider} from "./sharedEthClaimStore";

// A deliberately serialized transaction fake: verifies contract sequencing,
// NOT PostgreSQL behavior. Disposable Postgres concurrency tests still required.
class MemoryDB implements TransactionProvider {
 state={step:0,active_claim_id:null as string|null,version:0};
 claims=new Map<string,{status:string;settlement_id:string|null;step:number;outcome:string|null}>();
 private queue:Promise<unknown>=Promise.resolve();
 transaction<T>(work:(client:QueryClient)=>Promise<T>):Promise<T>{
   const next=this.queue.then(async()=>{
     const client:QueryClient={query:async <R extends Record<string,unknown>>(sql:string,params:readonly unknown[]=[])=>{
       let rows:Record<string,unknown>[]=[];
       if(sql.startsWith("SELECT step, active_claim_id")||sql.startsWith("SELECT step,active_claim_id"))rows=[{...this.state}];
       else if(sql.startsWith("SELECT status,settlement_id,step")){const claim=this.claims.get(String(params[0]));if(claim)rows=[{...claim}];}
       else if(sql.startsWith("INSERT INTO eth_shared_martingale_claims"))this.claims.set(String(params[0]),{status:"RESERVED",settlement_id:null,step:Number(params[4]),outcome:null});
       else if(sql.startsWith("UPDATE eth_shared_martingale_claims")){const claim=this.claims.get(String(params[0]));if(!claim)throw Error("unknown claim");claim.status=String(params[1]);claim.settlement_id=String(params[3]);claim.outcome=String(params[2]);}
       else if(sql.startsWith("UPDATE eth_shared_martingale_state SET active_claim_id")){this.state.active_claim_id=String(params[0]);this.state.version++;}
       else if(sql.startsWith("UPDATE eth_shared_martingale_state SET step")){this.state.step=Number(params[0]);this.state.active_claim_id=null;this.state.version++;}
       else throw Error("Unexpected SQL "+sql);
       return {rows:rows as R[]};
     }};
     return work(client);
   });
   this.queue=next.then(()=>{},()=>{});
   return next;
 }
 markSubmitted(id:string){const c=this.claims.get(id);if(!c)throw Error("missing");c.status="SUBMITTED";}
}
const request=(id:string,service:string)=>({claimId:id,service,ticker:"KXETH15M-TEST",side:"yes" as const});
describe("shared ETH claim state contract (in-memory only)",()=>{
 it("two simultaneous strategy signals grant exactly one reservation",async()=>{
   const db=new MemoryDB();
   const results=await Promise.all([claimFirstEthSignal(db,request("claim-a","G")),claimFirstEthSignal(db,request("claim-b","F"))]);
   assert.equal(results.filter(Boolean).length,1);
   assert.equal(db.claims.size,1);
   assert.equal(db.state.active_claim_id,results.find(Boolean)?.claimId);
 });
 it("loss advances; duplicate settlement is idempotent; next claim inherits stake",async()=>{
   const db=new MemoryDB();
   await claimFirstEthSignal(db,request("a","B"));db.markSubmitted("a");
   assert.deepEqual(await finalizeEthClaim(db,"a","settlement-a","LOSS"),{step:1,alreadyApplied:false});
   assert.deepEqual(await finalizeEthClaim(db,"a","settlement-a","LOSS"),{step:1,alreadyApplied:true});
   await assert.rejects(finalizeEthClaim(db,"a","settlement-other","LOSS"));
   await assert.rejects(finalizeEthClaim(db,"a","settlement-a","WIN"));
   const next=await claimFirstEthSignal(db,request("b","G"));
   assert.equal(next?.budgetCents,200);
 });
 it("zero fills preserve wager; unrelated claims cannot settle",async()=>{
   const db=new MemoryDB();
   await claimFirstEthSignal(db,request("a","E"));db.markSubmitted("a");
   await assert.rejects(finalizeEthClaim(db,"unknown","other","LOSS"));
   assert.deepEqual(await finalizeEthClaim(db,"a","settlement-a","ZERO_FILL"),{step:0,alreadyApplied:false});
   const next=await claimFirstEthSignal(db,request("b","L"));
   assert.equal(next?.budgetCents,100);
 });
 it("cannot settle a claim before it was submitted",async()=>{
   const db=new MemoryDB();await claimFirstEthSignal(db,request("a","C"));
   await assert.rejects(finalizeEthClaim(db,"a","settlement-a","WIN"));
   assert.equal(db.state.active_claim_id,"a");
 });
});
