import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {initializeUsdLadder} from './store.mjs';
import {prepareUsdEntry,validateUsdOrderBudget} from './entry-gate.mjs';
function setup(){const raw=new DatabaseSync(':memory:');const db={exec:s=>raw.exec(s),query:s=>raw.prepare(s)};initializeUsdLadder(db,'2026-10-16T00:00:00.000Z');db.exec('CREATE TABLE fx_live_order_claims(ticker TEXT PRIMARY KEY,created_at TEXT,side TEXT,status TEXT,exchange_order_id TEXT)');return {db,raw}}
test('budget is $1 when there are no pending claims',async()=>{const {db,raw}=setup();try{const p=await prepareUsdEntry(db,{});assert.equal(p.allowed,true);assert.equal(p.budgetCents,100);assert.equal(validateUsdOrderBudget(p,100),true);assert.equal(validateUsdOrderBudget(p,101),false)}finally{raw.close()}});
test('unresolved exchange order prevents all new entries',async()=>{const {db,raw}=setup();try{db.query('INSERT INTO fx_live_order_claims VALUES(?,?,?,?,?)').run('m','2026-10-16T01:00:00Z','YES','submitted',null);const p=await prepareUsdEntry(db,{});assert.equal(p.allowed,false);assert.equal(validateUsdOrderBudget(p,1),false)}finally{raw.close()}});
test('settled filled loss advances next approved budget',async()=>{const {db,raw}=setup();try{db.query('INSERT INTO fx_live_order_claims VALUES(?,?,?,?,?)').run('m','2026-10-16T01:00:00Z','YES','submitted','x');const p=await prepareUsdEntry(db,{getOrder:async()=>({status:'executed',fill_count_fp:'1.00'}),getMarket:async()=>({result:'no'})});assert.equal(p.allowed,true);assert.equal(p.budgetCents,200);assert.equal(validateUsdOrderBudget(p,201),false)}finally{raw.close()}});
