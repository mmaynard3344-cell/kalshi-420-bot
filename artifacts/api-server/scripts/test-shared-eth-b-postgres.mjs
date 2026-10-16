// Run ONLY with disposable PostgreSQL: TEST_DATABASE_URL=... node --experimental-strip-types ...
// Requires pg package; intentionally refuses production-looking URLs.
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import pg from "pg";
import {build} from "esbuild";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {pathToFileURL} from "node:url";
const temp=await mkdtemp(join(tmpdir(),"eth-shared-pg-"));
const outfile=join(temp,"claim-bundle.mjs");
await build({entryPoints:[resolve("src/lib/sharedEthClaimStore.ts")],bundle:true,platform:"node",format:"esm",outfile,packages:"external"});
const {claimFirstEthSignal,finalizeEthClaim,markEthClaimSubmitted,releaseUnsubmittedEthClaim}=await import(pathToFileURL(outfile).href);
const gatewayFile=join(temp,"gateway-bundle.mjs");
await build({entryPoints:[resolve("src/lib/sharedEthOrderGateway.ts")],bundle:true,platform:"node",format:"esm",outfile:gatewayFile,packages:"external"});
const {submitThroughSharedEthGate}=await import(pathToFileURL(gatewayFile).href);
const bAdapterFile=join(temp,"b-adapter.mjs");
await build({entryPoints:[resolve("src/lib/strategies/ethJumpSharedAdapter.ts")],bundle:true,platform:"node",format:"esm",outfile:bAdapterFile,packages:"external"});

const url=process.env.TEST_DATABASE_URL;
if(!url)throw Error("TEST_DATABASE_URL must point to an isolated throwaway PostgreSQL database");
const parsed=new URL(url);
if(!/(test|disposable|ephemeral)/i.test(parsed.pathname+" "+parsed.hostname))throw Error("Refusing database without disposable/test name");
const pool=new pg.Pool({connectionString:url,max:4});
const txProvider={async transaction(fn){
 const c=await pool.connect();
 try {await c.query("BEGIN");const result=await fn(c);await c.query("COMMIT");return result;}
 catch(e){await c.query("ROLLBACK");throw e;}
 finally{c.release();}
}};
try{
 await pool.query("DROP TABLE IF EXISTS eth_shared_martingale_claims");
 await pool.query("DROP TABLE IF EXISTS eth_shared_martingale_state");
 await pool.query("CREATE TABLE eth_shared_martingale_state(singleton boolean primary key default true check(singleton),step smallint not null default 0,active_claim_id uuid unique,version bigint not null default 0,updated_at timestamptz not null default now())");
 await pool.query("INSERT INTO eth_shared_martingale_state(singleton) VALUES(true)");
 await pool.query("CREATE TABLE eth_shared_martingale_claims(claim_id uuid primary key,service text not null,ticker text not null,side text not null,step smallint not null,budget_cents integer not null,status text not null default 'RESERVED',order_id text unique,outcome text,settlement_id text unique,created_at timestamptz default now(),resolved_at timestamptz)");
 const make=(service)=>({claimId:randomUUID(),service,ticker:"KXETH15M-TEST",side:"yes"});
 const [a,b]=await Promise.all([claimFirstEthSignal(txProvider,make("G")),claimFirstEthSignal(txProvider,make("F"))]);
 assert.equal([a,b].filter(Boolean).length,1,"only one claim wins concurrent DB row lock");
 const won=a||b;await pool.query("UPDATE eth_shared_martingale_claims SET status='SUBMITTED' WHERE claim_id=$1",[won.claimId]);
 const loss=await finalizeEthClaim(txProvider,won.claimId,randomUUID(),"LOSS");assert.equal(loss.step,1);
 const second=await claimFirstEthSignal(txProvider,make("E"));assert.equal(second.budgetCents,200);
 // A submitted partially filled order must survive a fresh DB connection/restart.
 await markEthClaimSubmitted(txProvider,second.claimId,"exchange-partial-1");
 const blocked=await claimFirstEthSignal(txProvider,make("B"));
 assert.equal(blocked,null,"partial fill keeps shared slot locked");
 assert.equal(await releaseUnsubmittedEthClaim(txProvider,second.claimId),false,"submitted trade cannot be released as unsubmitted");
 const persisted=await pool.query("SELECT status,order_id FROM eth_shared_martingale_claims WHERE claim_id=$1",[second.claimId]);
 assert.equal(persisted.rows[0].status,"SUBMITTED");
 assert.equal(persisted.rows[0].order_id,"exchange-partial-1");
 const third=await claimFirstEthSignal(txProvider,make("L"));assert.equal(third,null,"fresh transaction still sees held claim");
 // Only authenticated final settlement unlocks the submitted partial-fill claim.
 const resultId=randomUUID();
 const settled=await finalizeEthClaim(txProvider,second.claimId,resultId,"WIN");
 assert.equal(settled.step,0);
 assert.equal((await finalizeEthClaim(txProvider,second.claimId,resultId,"WIN")).alreadyApplied,true);
 const after=await claimFirstEthSignal(txProvider,make("H"));assert.equal(after.budgetCents,100);
 assert.equal(await releaseUnsubmittedEthClaim(txProvider,after.claimId),true);
 const next=await claimFirstEthSignal(txProvider,make("C"));assert.equal(next.budgetCents,100);
 console.log("PASS: submitted partial-fill reservation survives independent transactions and releases only on settlement; duplicate settlement idempotent");
 assert.equal(await releaseUnsubmittedEthClaim(txProvider,next.claimId),true);
 const makeGateway=(svc)=>({service:svc,ticker:"KXETH15M-26OCT161500-00",side:"yes",clientOrderId:"gate-"+svc});
 const [g1,g2]=await Promise.all([
  submitThroughSharedEthGate(txProvider,makeGateway("G"),async()=>{throw Error("network timeout after POST");}),
  submitThroughSharedEthGate(txProvider,makeGateway("F"),async()=>({accepted:true}))
 ]);
 assert.equal([g1,g2].filter(x=>x.status!=="SKIPPED_ACTIVE_CLAIM").length,1,"one G/F gateway winner");
 const winner=g1.status!=="SKIPPED_ACTIVE_CLAIM"?g1:g2;
 const blockedAfter=await claimFirstEthSignal(txProvider,make("B"));
 assert.equal(blockedAfter,null,"uncertain or accepted submission must hold cross-service reservation");
 const persistedGateway=await pool.query("SELECT status,order_id FROM eth_shared_martingale_claims WHERE claim_id=$1",[winner.claim.claimId]);
 assert.equal(persistedGateway.rows[0].status,"SUBMITTED");
 assert.equal(persistedGateway.rows[0].order_id,g1.status!=="SKIPPED_ACTIVE_CLAIM"?"gate-G":"gate-F");
 console.log("PASS: shared submission gateway serializes G/F and keeps the reservation after submission");
 console.log("PASS: independent PostgreSQL connections serialize claims and advance stake after loss");
}finally{
 await pool.end();
 await rm(temp,{recursive:true,force:true});
}
