// Read-only durable recovery of the current BTC ladder reservation.
// Query only; never releases a pending order based on stale history.
export async function loadPendingBtcReservation(pool) {
 if(!pool||typeof pool.connect!=="function")throw Error("BTC ladder DB unavailable");
 const client=await pool.connect();
 try{
  const {rows}=await client.query("SELECT step,pending_order_id,pending_settlement_id,version FROM btc_shared_ladder WHERE market='BTC'");
  if(rows.length!==1)throw Error("BTC ladder missing");
  const r=rows[0];
  if(!Number.isInteger(Number(r.step))||Number(r.step)<0||Number(r.step)>5)throw Error("invalid BTC ladder state");
  return {step:Number(r.step),orderId:r.pending_order_id??null,settlementId:r.pending_settlement_id??null,version:Number(r.version),reconciliationRequired:!!(r.pending_order_id||r.pending_settlement_id)};
 }finally{client.release()}
}
