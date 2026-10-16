import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {initializeUsdLadder,getUsdLadder} from './store.mjs';
import {prepareUsdEntry} from './entry-gate.mjs';
function setup(){
 const raw=new DatabaseSync(':memory:');
 const db={exec:s=>raw.exec(s),query:s=>raw.prepare(s)};
 initializeUsdLadder(db,'2026-10-16T00:00:00.000Z');
 db.exec('CREATE TABLE fx_live_order_claims(ticker TEXT PRIMARY KEY,created_at TEXT,side TEXT,status TEXT,exchange_order_id TEXT,client_order_id TEXT)');
 return {raw,db};
}
function claim(db,ticker,side,id,client){
 db.query('INSERT INTO fx_live_order_claims VALUES(?,?,?,?,?,?)').run(ticker,'2026-10-16T01:00:00.000Z',side,'claimed',id,client);
}
test('complete simulated progression: fill loss, fill win, canceled zero fill',async()=>{
 const {raw,db}=setup();
 try{
  const book=new Map();const outcomes=new Map();
  const api={
   getOrder:async id=>book.get(id)??(assert.fail('unknown order '+id)),
   getMarket:async ticker=>({result:outcomes.get(ticker)}),
   findOrderByClientId:async()=>null
  };
  let gate=await prepareUsdEntry(db,api);
  assert.deepEqual([gate.allowed,gate.step,gate.budgetCents],[true,0,100]);
  claim(db,'loss','YES','id-loss','client-loss');
  book.set('id-loss',{fill_count_fp:'1.00',status:'executed'});
  outcomes.set('loss','no');
  gate=await prepareUsdEntry(db,api);
  assert.deepEqual([gate.allowed,gate.step,gate.budgetCents],[true,1,200]);
  claim(db,'win','NO','id-win','client-win');
  book.set('id-win',{fill_count_fp:'1.00',status:'executed'});
  outcomes.set('win','no');
  gate=await prepareUsdEntry(db,api);
  assert.deepEqual([gate.allowed,gate.step,gate.budgetCents],[true,0,100]);
  claim(db,'cancel','YES','id-cancel','client-cancel');
  book.set('id-cancel',{fill_count_fp:'0.00',status:'canceled'});
  gate=await prepareUsdEntry(db,api);
  assert.deepEqual([gate.allowed,gate.step,gate.budgetCents],[true,0,100]);
  assert.equal(db.query('SELECT COUNT(*) AS n FROM fx_ladder_events').get().n,3);
  assert.deepEqual(db.query('SELECT outcome FROM fx_ladder_events ORDER BY rowid').all().map(x=>x.outcome),['LOSS','WIN','ZERO_FILL']);
  gate=await prepareUsdEntry(db,api);
  assert.equal(db.query('SELECT COUNT(*) AS n FROM fx_ladder_events').get().n,3);
 }finally{raw.close()}
});
test('ambiguous submission recovers exact client order once without resubmission',async()=>{
 const {raw,db}=setup();
 try{
  claim(db,'ambiguous','YES',null,'expected-client');
  const lookup=async(client,ticker)=>({order_id:'recovered-id',client_order_id:client,ticker});
  let gate=await prepareUsdEntry(db,{findOrderByClientId:lookup,getOrder:async()=>({fill_count_fp:'1.00',status:'executed'}),getMarket:async()=>({result:null})});
  assert.equal(gate.allowed,false);
  assert.equal(db.query('SELECT exchange_order_id FROM fx_live_order_claims WHERE ticker=?').get('ambiguous').exchange_order_id,'recovered-id');
  gate=await prepareUsdEntry(db,{findOrderByClientId:lookup,getOrder:async()=>({fill_count_fp:'1.00',status:'executed'}),getMarket:async()=>({result:'no'})});
  assert.deepEqual([gate.allowed,gate.step,gate.budgetCents],[true,1,200]);
  assert.equal(db.query('SELECT COUNT(*) AS n FROM fx_ladder_events').get().n,1);
 }finally{raw.close()}
});
test('ambiguous submission with mismatched client id remains blocked',async()=>{
 const {raw,db}=setup();
 try{
  claim(db,'unknown','YES',null,'expected-client');
  const gate=await prepareUsdEntry(db,{findOrderByClientId:async()=>({order_id:'other-id',client_order_id:'wrong-client',ticker:'unknown'}),getOrder:async()=>assert.fail('should not fetch mismatched order')});
  assert.equal(gate.allowed,false);
  assert.equal(getUsdLadder(db).step,0);
 }finally{raw.close()}
});
