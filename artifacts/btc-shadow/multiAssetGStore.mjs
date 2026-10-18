// Durable SOL/XRP/DOGE G coordination, no exchange submission.
// Caller applies multiAssetG.sql in a disposable test DB before use.
import { initialLadder, reserve, applyVerifiedResult, stakeCents, assertAsset } from "./multiAssetGCore.mjs";
const read = (asset,row) => {
  if (!row) throw Error("g_asset_not_initialized");
  const current={...initialLadder(asset),step:Number(row.step),pendingOrderId:row.pending_order_id,version:Number(row.version)};
  stakeCents(current);
  return current;
};
async function transaction(pool,asset,fn){
  assertAsset(asset);
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const state=await client.query("SELECT * FROM multi_asset_g_ladders WHERE asset=$1 FOR UPDATE",[asset]);
    const old=read(asset,state.rows[0]);
    const out=await fn(old,client);
    await client.query("COMMIT");
    return out;
  }catch(error){try{await client.query("ROLLBACK")}catch{}throw error}
  finally{client.release()}
}
async function persist(client,previous,next){
 const result=await client.query(
   "UPDATE multi_asset_g_ladders SET step=$2,pending_order_id=$3,version=$4,updated_at=now() WHERE asset=$1 AND version=$5",
   [previous.asset,next.step,next.pendingOrderId,next.version,previous.version]);
 if(result.rowCount!==1)throw Error("g_asset_version_conflict");
}
export async function reserveAssetG(pool,{asset,orderId,ticker,side}){
 const series=assertAsset(asset);
 if(typeof ticker!=="string"||!ticker.startsWith(series+"-"))throw Error("g_asset_ticker_mismatch");
 if(side!=="yes"&&side!=="no")throw Error("invalid_g_side");
 return transaction(pool,asset,async(old,client)=>{
   const next=reserve(old,orderId);
   await client.query("INSERT INTO multi_asset_g_order_identity(asset,client_order_id,ticker,side) VALUES($1,$2,$3,$4)",
     [asset,orderId,ticker,side]);
   await client.query("INSERT INTO multi_asset_g_events(asset,kind,order_id,prior_step,next_step) VALUES($1,'RESERVED',$2,$3,$4)",
     [asset,orderId,old.step,next.step]);
   await persist(client,old,next);
   return {asset,orderId,stakeCents:stakeCents(old),step:old.step};
 });
}
// No exchange result may be inferred here. The caller must have independently
// verified a corresponding fill and final market result before invoking this.
export async function settleVerifiedAssetG(pool,{asset,orderId,settlementId,result}){
 if(typeof settlementId!=="string"||!settlementId)throw Error("missing_verified_settlement_id");
 if(result!=="win"&&result!=="loss")throw Error("invalid_verified_settlement");
 return transaction(pool,asset,async(old,client)=>{
  if(old.pendingOrderId!==orderId)throw Error("g_asset_order_mismatch");
  const identity=await client.query(
    "SELECT 1 FROM multi_asset_g_order_identity WHERE asset=$1 AND client_order_id=$2",[asset,orderId]);
  if(identity.rowCount!==1)throw Error("g_asset_order_identity_missing");
  const next=applyVerifiedResult(old,orderId,result);
  await client.query("INSERT INTO multi_asset_g_events(asset,kind,order_id,settlement_id,prior_step,next_step) VALUES($1,$2,$3,$4,$5,$6)",
   [asset,result==="win"?"WIN":"LOSS",orderId,settlementId,old.step,next.step]);
  await persist(client,old,next);
  await client.query("UPDATE multi_asset_g_ladders SET last_settlement_id=$2 WHERE asset=$1",[asset,settlementId]);
  return {asset,step:next.step,stakeCents:stakeCents(next)};
 });
}
export async function readAssetG(pool,asset){
 assertAsset(asset);
 const res=await pool.query("SELECT asset,step,pending_order_id,pending_settlement_id,last_settlement_id,version,updated_at FROM multi_asset_g_ladders WHERE asset=$1",[asset]);
 return res.rows[0]??null;
}
