import {sharedEthPgProvider} from "../sharedEthPgProvider.js";
import type {TransactionProvider} from "../sharedEthClaimStore.js";

type BLink={claimId:string;clientOrderId:string;ticker:string;side:"yes"|"no";exchangeOrderId:string|null};
export async function recordBClaimBeforePost(link:Omit<BLink,"exchangeOrderId"> & {contracts:number},provider:TransactionProvider=sharedEthPgProvider):Promise<void>{
 if(!link.claimId||!link.clientOrderId||!link.ticker.startsWith("KXETH15M-")||!Number.isSafeInteger(link.contracts)||link.contracts<1)throw Error("invalid B claim journal");
 await provider.transaction(async tx=>{
  const inserted=await tx.query("INSERT INTO eth_b_shared_claim_links (claim_id,client_order_id,ticker,side,requested_contracts,created_at_ms) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING claim_id",
   [link.claimId,link.clientOrderId,link.ticker,link.side,link.contracts,Date.now()]);
  if(inserted.rows.length!==1)throw Error("duplicate B claim journal; retain shared fence");
 });
}
export async function recordBExchangeOrderId(claimId:string,exchangeOrderId:string,provider:TransactionProvider=sharedEthPgProvider):Promise<void>{
 if(!claimId||!exchangeOrderId)throw Error("missing exchange order identity");
 await provider.transaction(async tx=>{
  const result=await tx.query("UPDATE eth_b_shared_claim_links SET exchange_order_id=$2 WHERE claim_id=$1 AND (exchange_order_id IS NULL OR exchange_order_id=$2) RETURNING claim_id",[claimId,exchangeOrderId]);
  if(result.rows.length!==1)throw Error("B exchange ID mismatch; retain shared fence");
 });
}
export async function listUnresolvedBSharedClaims(provider:TransactionProvider=sharedEthPgProvider):Promise<BLink[]>{
 return provider.transaction(async tx=>{
  const result=await tx.query<{claim_id:string;client_order_id:string;ticker:string;side:"yes"|"no";exchange_order_id:string|null}>(`SELECT l.claim_id,l.client_order_id,l.ticker,l.side,l.exchange_order_id FROM eth_b_shared_claim_links l JOIN eth_shared_martingale_claims c ON c.claim_id=l.claim_id WHERE c.status='SUBMITTED' ORDER BY l.created_at_ms ASC LIMIT 100`);
  return result.rows.map(row=>({claimId:row.claim_id,clientOrderId:row.client_order_id,ticker:row.ticker,side:row.side,exchangeOrderId:row.exchange_order_id}));
 });
}
