import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeUsdLadder, getUsdLadder } from './store.mjs';
import { prepareUsdEntry } from './entry-gate.mjs';
function dbFixture(){const raw=new DatabaseSync(':memory:');const db={exec:s=>raw.exec(s),query:s=>raw.prepare(s)};initializeUsdLadder(db,'2026-10-16T00:00:00.000Z');db.exec('CREATE TABLE fx_live_order_claims(ticker TEXT PRIMARY KEY,created_at TEXT,side TEXT,status TEXT,exchange_order_id TEXT)');return {db,raw};}
test('an unverified exchange order never raises stake despite any simulated win or loss',async()=>{const {db,raw}=dbFixture();try{db.query('INSERT INTO fx_live_order_claims VALUES(?,?,?,?,?)').run('fx','2026-10-16T01:00:00.000Z','NO','submitted','order');const state=await prepareUsdEntry(db,{getOrder:async()=>({status:'executed',fill_count_fp:'1.00'}),getMarket:async()=>({result:null})});assert.equal(state.allowed,false);assert.equal(getUsdLadder(db).step,0)}finally{raw.close()}});
test('an authenticated lookup error leaves ladder blocked',async()=>{const {db,raw}=dbFixture();try{db.query('INSERT INTO fx_live_order_claims VALUES(?,?,?,?,?)').run('fx','2026-10-16T01:00:00.000Z','YES','submitted','order');const state=await prepareUsdEntry(db,{getOrder:async()=>{throw Error('exchange unavailable')},getMarket:async()=>({result:'no'})});assert.equal(state.allowed,false);assert.equal(getUsdLadder(db).step,0)}finally{raw.close()}});
