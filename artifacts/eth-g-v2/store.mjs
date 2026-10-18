// ETH G v2 durable state. Callers must verify exchange evidence externally.
import {nextStep,stake} from "./core.mjs";
async function locked(pool,fn){
 const c=await pool.connect();
 try{
  await c.query("BEGIN");
  const r=await c.query("SELECT * FROM eth_g_v2_state WHERE id=1 FOR UPDATE");
  if(r.rowCount!==1)throw Error("eth_g_v2_state_missing");
  const output=await fn(c,r.rows[0]);
  await c.query("COMMIT");
  return output;
 }catch(e){try{await c.query("ROLLBACK")}catch{}throw e}finally{c.release()}
}
export async function reserveEthG(pool,{clientOrderId,ticker,side,triggerKey}){
 if(!clientOrderId||!triggerKey||!/^KXETH15M-/.test(ticker)||!["yes","no"].includes(side))throw Error("invalid_eth_g_reservation");
 return locked(pool,async(c,state)=>{
  if(state.pending_client_order_id)throw Error("eth_g_v2_order_pending");
  if(state.last_trigger_key===triggerKey)throw Error("eth_g_v2_trigger_replayed");
  const step=Number(state.step),amount=stake(step);
  await c.query("INSERT INTO eth_g_v2_orders(client_order_id,ticker,side) VALUES($1,$2,$3)",[clientOrderId,ticker,side]);
  const u=await c.query("UPDATE eth_g_v2_state SET pending_client_order_id=$1,last_trigger_key=$2,version=version+1,updated_at=now() WHERE id=1 AND version=$3",
    [clientOrderId,triggerKey,state.version]);
  if(u.rowCount!==1)throw Error("eth_g_v2_version_conflict");
  return {clientOrderId,step,stakeCents:amount};
 });
}
export async function attachVerifiedEthGFill(pool,{clientOrderId,exchangeOrderId,filledContracts}){
 if(!clientOrderId||!exchangeOrderId||!Number.isSafeInteger(filledContracts)||filledContracts<=0)throw Error("invalid_verified_fill");
 return locked(pool,async(c,state)=>{
  if(state.pending_client_order_id!==clientOrderId)throw Error("eth_g_v2_order_mismatch");
  const result=await c.query("UPDATE eth_g_v2_orders SET exchange_order_id=$2,verified_filled_contracts=$3 WHERE client_order_id=$1 AND (exchange_order_id IS NULL OR exchange_order_id=$2) AND verified_filled_contracts <= $3",
    [clientOrderId,exchangeOrderId,filledContracts]);
  if(result.rowCount!==1)throw Error("eth_g_v2_fill_identity_conflict");
  return {clientOrderId,filledContracts};
 });
}
export async function settleVerifiedEthG(pool,{clientOrderId,settlementId,outcome}){
 if(!clientOrderId||!settlementId||!["win","loss"].includes(outcome))throw Error("unverified_settlement");
 return locked(pool,async(c,state)=>{
  if(state.pending_client_order_id!==clientOrderId)throw Error("eth_g_v2_order_mismatch");
  const evidence=await c.query("SELECT 1 FROM eth_g_v2_orders WHERE client_order_id=$1 AND exchange_order_id IS NOT NULL AND verified_filled_contracts>0",[clientOrderId]);
  if(evidence.rowCount!==1)throw Error("eth_g_v2_verified_fill_missing");
  const before=Number(state.step),after=nextStep(before,outcome);
  await c.query("INSERT INTO eth_g_v2_settlements(settlement_id,client_order_id,outcome,previous_step,next_step) VALUES($1,$2,$3,$4,$5)",
    [settlementId,clientOrderId,outcome,before,after]);
  const u=await c.query("UPDATE eth_g_v2_state SET step=$1,pending_client_order_id=NULL,last_settlement_id=$2,version=version+1,updated_at=now() WHERE id=1 AND version=$3",
    [after,settlementId,state.version]);
  if(u.rowCount!==1)throw Error("eth_g_v2_version_conflict");
  return {step:after,stakeCents:stake(after)};
 });
}

export async function getPendingEthG(pool){
 const r=await pool.query(
  "SELECT s.step,s.pending_client_order_id,o.ticker,o.side,o.exchange_order_id,o.verified_filled_contracts FROM eth_g_v2_state s LEFT JOIN eth_g_v2_orders o ON o.client_order_id=s.pending_client_order_id WHERE s.id=1");
 const row=r.rows[0];
 if(!row)throw Error("eth_g_v2_state_missing");
 if(!row.pending_client_order_id)return null;
 if(!row.ticker||!row.side)throw Error("eth_g_v2_pending_identity_missing");
 return {step:Number(row.step),clientOrderId:row.pending_client_order_id,ticker:row.ticker,
  side:row.side,exchangeOrderId:row.exchange_order_id,filledContracts:Number(row.verified_filled_contracts)};
}

export async function attachEthGExchangeOrderId(pool,{clientOrderId,exchangeOrderId}){
 if(!clientOrderId||!exchangeOrderId)throw Error("invalid_exchange_identity");
 return locked(pool,async(c,state)=>{
  if(state.pending_client_order_id!==clientOrderId)throw Error("eth_g_v2_order_mismatch");
  const r=await c.query(
   "UPDATE eth_g_v2_orders SET exchange_order_id=$2 WHERE client_order_id=$1 AND (exchange_order_id IS NULL OR exchange_order_id=$2)",
   [clientOrderId,exchangeOrderId]);
  if(r.rowCount!==1)throw Error("eth_g_v2_exchange_identity_conflict");
  return {clientOrderId,exchangeOrderId};
 });
}
