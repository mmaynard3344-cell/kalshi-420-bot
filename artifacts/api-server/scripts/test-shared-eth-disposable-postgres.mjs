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
const {claimFirstEthSignal,finalizeEthClaim}=await import(pathToFileURL(outfile).href);
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
 console.log("PASS: independent PostgreSQL connections serialize claims and advance stake after loss");
}finally{
 await pool.end();
 await rm(temp,{recursive:true,force:true});
}
