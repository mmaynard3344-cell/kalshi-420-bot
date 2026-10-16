import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {initializeUsdLadder,getUsdLadder} from './store.mjs';
import {prepareUsdEntry} from './entry-gate.mjs';
function make(){const raw=new DatabaseSync(':memory:');const db={exec:s=>raw.exec(s),query:s=>raw.prepare(s)};initializeUsdLadder(db,'2026-10-16T00:00:00.000Z');db.exec('CREATE TABLE fx_live_order_claims(ticker TEXT PRIMARY KEY,created_at TEXT,side TEXT,status TEXT,exchange_order_id TEXT)');return {raw,db}}
test('interrupted POST after durable claim with unknown order id blocks all future entries',async()=>{const {raw,db}=make();try{db.query('INSERT INTO fx_live_order_claims VALUES(?,?,?,?,?)').run('fx','2026-10-16T01:00:00.000Z','YES','claimed',null);const out=await prepareUsdEntry(db,{getOrder:async()=>{throw Error('should never be used')}});assert.equal(out.allowed,false);assert.equal(getUsdLadder(db).step,0)}finally{raw.close()}});
test('exchange timeout leaves unsettled claim and unchanged ladder step',async()=>{const {raw,db}=make();try{db.query('INSERT INTO fx_live_order_claims VALUES(?,?,?,?,?)').run('fx','2026-10-16T01:00:00.000Z','NO','submitted','exchange-id');const out=await prepareUsdEntry(db,{getOrder:async()=>{throw Error('timeout')},getMarket:async()=>({result:'yes'})});assert.equal(out.allowed,false);assert.equal(getUsdLadder(db).step,0)}finally{raw.close()}});
