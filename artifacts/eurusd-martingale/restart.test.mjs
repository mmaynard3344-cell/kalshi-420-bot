import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {initializeUsdLadder,getUsdLadder,applyUsdSettlement} from './store.mjs';
test('file-backed restart preserves step and does not apply a settlement twice',()=>{
 const dir=mkdtempSync(join(tmpdir(),'usd-ladder-'));
 const path=join(dir,'ladder.sqlite');
 const open=()=>{const raw=new DatabaseSync(path);return {raw,db:{exec:s=>raw.exec(s),query:s=>raw.prepare(s)}}};
 try{
   let x=open(); initializeUsdLadder(x.db,'2026-10-16T00:00:00.000Z');
   const evt={ticker:'KXEURUSD15M-TEST',createdAt:'2026-10-16T01:00:00.000Z',filledContracts:1,orderStatus:'executed',marketResult:'no',side:'YES',settledAt:'2026-10-16T01:20:00.000Z'};
   assert.equal(applyUsdSettlement(x.db,evt).status,'APPLIED');
   assert.equal(getUsdLadder(x.db).step,1);x.raw.close();
   x=open();initializeUsdLadder(x.db,'2026-10-16T02:00:00.000Z');
   assert.equal(getUsdLadder(x.db).step,1);
   assert.equal(getUsdLadder(x.db).activated_at,'2026-10-16T00:00:00.000Z');
   assert.equal(applyUsdSettlement(x.db,evt).status,'ALREADY_APPLIED');
   assert.equal(getUsdLadder(x.db).step,1);x.raw.close();
 }finally{rmSync(dir,{recursive:true,force:true})}
});