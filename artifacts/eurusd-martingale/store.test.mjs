import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeUsdLadder, getUsdLadder, applyUsdSettlement, hasUnresolvedUsdOrders } from './store.mjs';
import {USD_STAKES_CENTS} from './ladder.mjs';
function fixture(fn){
 const raw=new DatabaseSync(':memory:');
 const db={exec:s=>raw.exec(s),query:s=>raw.prepare(s)};
 initializeUsdLadder(db,'2026-10-16T02:00:00.000Z');
 db.exec('CREATE TABLE fx_live_order_claims (ticker TEXT,created_at TEXT,status TEXT)');
 try{fn(db)}finally{raw.close()}
}
const o=(ticker,marketResult='no',filledContracts=1,orderStatus='executed')=>({ticker,createdAt:'2026-10-16T02:01:00.000Z',side:'YES',marketResult,filledContracts,orderStatus,settledAt:'2026-10-16T02:20:00.000Z'});
test('six losing settlements follow configured budget sequence',()=>fixture(db=>{let seen=[];for(let i=0;i<6;i++){seen.push(getUsdLadder(db).budgetCents);applyUsdSettlement(db,o('t'+i))}assert.deepEqual(seen,USD_STAKES_CENTS);assert.equal(getUsdLadder(db).step,0)}));
test('zero fill unchanged, win resets and duplicate idempotent',()=>fixture(db=>{applyUsdSettlement(db,o('lose'));assert.equal(getUsdLadder(db).step,1);applyUsdSettlement(db,o('zero','no',0,'canceled'));assert.equal(getUsdLadder(db).step,1);applyUsdSettlement(db,o('win','yes'));assert.equal(getUsdLadder(db).step,0);assert.equal(applyUsdSettlement(db,o('win','yes')).status,'ALREADY_APPLIED')}));
test('unresolved and legacy orders cannot advance',()=>fixture(db=>{assert.equal(applyUsdSettlement(db,o('unknown',null)).status,'UNRESOLVED');assert.throws(()=>applyUsdSettlement(db,{...o('old'),createdAt:'2026-10-15T00:00:00Z'}),/legacy/);assert.equal(getUsdLadder(db).step,0)}));
test('unresolved live claim blocks new order',()=>fixture(db=>{db.query('INSERT INTO fx_live_order_claims VALUES(?,?,?)').run('pending','2026-10-16T02:01:00.000Z','submitted');assert.equal(hasUnresolvedUsdOrders(db),true)}));