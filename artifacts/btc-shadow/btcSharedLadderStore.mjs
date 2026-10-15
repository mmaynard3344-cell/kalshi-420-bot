// PostgreSQL BTC ladder state coordinator. REVIEW ONLY. Never submits Kalshi orders.
// Requires the SQL migration in btcSharedLadder.sql and a pg-compatible client
// with connect() returning a dedicated transaction client.
import {claim,confirmFill,confirmZeroFill,confirmSettlement,initialBtcLadder,stakeCents} from "./btcSharedLadder.mjs";
function readState(row){
 if(!row)throw Error("BTC ladder schema not migrated");
 const state={step:Number(row.step),pendingOrderId:row.pending_order_id,pendingSettlementId:row.pending_settlement_id,lastSettlementId:row.last_settlement_id,version:Number(row.version)};
 if(!Number.isInteger(state.step)||state.step<0||state.step>5||!Number.isSafeInteger(state.version)||state.version<0)throw Error("corrupt BTC ladder");
 return state;
}
export async function btcLadderTransaction(pool,fn){
 if(!pool||typeof pool.connect!=="function")throw Error("BTC ladder DB unavailable");
 const client=await pool.connect();
 try{
  await client.query("BEGIN");
  const {rows}=await client.query("SELECT step,pending_order_id,pending_settlement_id,last_settlement_id,version FROM btc_shared_ladder WHERE market = 'BTC' FOR UPDATE");
  const current=readState(rows[0]);
  const outcome=await fn(current,client);
  await client.query("COMMIT");
  return outcome;
 }catch(err){try{await client.query("ROLLBACK")}catch{}throw err}
 finally{client.release()}
}
async function persist(client,state){
 const r=await client.query("UPDATE btc_shared_ladder SET step=$1,pending_order_id=$2,pending_settlement_id=$3,last_settlement_id=$4,version=$5,updated_at=now() WHERE market='BTC' AND version=$6 RETURNING version",
 [state.step,state.pendingOrderId,state.pendingSettlementId,state.lastSettlementId,state.version,state.version-1]);
 if(r.rowCount!==1)throw Error("BTC ladder CAS failed");
}
async function event(client,kind,orderId,settlementId,previous,next){
 await client.query("INSERT INTO btc_shared_ladder_events(kind,order_id,settlement_id,prior_step,next_step) VALUES($1,$2,$3,$4,$5)",
 [kind,orderId,settlementId,previous.step,next.step]);
}
export async function reserveBtcWager(pool,orderId){
 return btcLadderTransaction(pool,async (prior,client)=>{
  const next=claim(prior,orderId);
  await event(client,"RESERVED",orderId,null,prior,next);
  await persist(client,next);
  return {stakeCents:stakeCents(prior),version:next.version};
 });
}
export async function recordBtcFilled(pool,orderId,settlementId){
 return btcLadderTransaction(pool,async (prior,client)=>{
  const next=confirmFill(prior,orderId,settlementId);
  await event(client,"FILLED",orderId,settlementId,prior,next);
  await persist(client,next);
  return next;
 });
}
export async function recordBtcVerifiedZeroFill(pool,orderId){
 return btcLadderTransaction(pool,async (prior,client)=>{
  const next=confirmZeroFill(prior,orderId);
  await event(client,"ZERO_FILL",orderId,null,prior,next);
  await persist(client,next);
  return next;
 });
}
export async function recordBtcVerifiedSettlement(pool,settlementId,outcome){
 return btcLadderTransaction(pool,async (prior,client)=>{
  const already=await client.query("SELECT 1 FROM btc_shared_ladder_events WHERE settlement_id=$1 AND kind IN ('WIN','LOSS') LIMIT 1",[settlementId]);
  if(already.rowCount>0)return {alreadyProcessed:true,step:prior.step};
  const next=confirmSettlement(prior,settlementId,outcome);
  await event(client,outcome,null,settlementId,prior,next);
  await persist(client,next);
  return {alreadyProcessed:false,step:next.step};
 });
}
