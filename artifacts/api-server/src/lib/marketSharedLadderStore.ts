/** Transactional database adapter for per-market six-step ladders.
 * REVIEW ONLY: No live order path imports this module yet.
 * Requires market_six_step_ladders.review.sql to be applied.
 * Caller must pass the Drizzle transaction handle from @workspace/db.
 */
import {sql} from "drizzle-orm";
import {reserveOrder,markFilled,releaseNoFill,settle,wagerDollars,type MarketLadder,type LadderState,type LadderOutcome} from "./marketSharedLadder.js";
type Tx={execute:(query:unknown)=>Promise<any>};
function rowValue(raw:any):any {
 return raw?.rows?.[0] ?? raw?.[0] ?? null;
}
function parseRow(row:any,market:MarketLadder):LadderState{
 if(!row)throw Error("ladder row missing");
 if(row.market!==market)throw Error("ladder market mismatch");
 const step=Number(row.step),version=Number(row.version);
 if(!Number.isInteger(step)||step<0||step>5||!Number.isSafeInteger(version)||version<0)throw Error("invalid persisted market ladder state");
 return {market,step,pendingOrderId:row.pending_order_id??null,pendingSettlementId:row.pending_settlement_id??null,lastSettlementId:row.last_settlement_id??null,version};
}
async function locked(tx:Tx,market:MarketLadder):Promise<LadderState>{
 if(!["BTC","ETH","EURUSD"].includes(market))throw Error("unsupported market");
 const result=await tx.execute(sql`SELECT market,step,pending_order_id,pending_settlement_id,last_settlement_id,version FROM market_six_step_ladders WHERE market=${market} FOR UPDATE`);
 return parseRow(rowValue(result),market);
}
async function save(tx:Tx,s:LadderState):Promise<void>{
 const result=await tx.execute(sql`UPDATE market_six_step_ladders SET step=${s.step},pending_order_id=${s.pendingOrderId},pending_settlement_id=${s.pendingSettlementId},last_settlement_id=${s.lastSettlementId},version=${s.version},updated_at=NOW() WHERE market=${s.market} AND version=${s.version-1} RETURNING version`);
 if(!rowValue(result))throw Error("market ladder compare-and-set failed");
}
export async function reserveMarketLadder(tx:Tx,market:MarketLadder,orderId:string):Promise<{dollars:number;state:LadderState}>{
 const prior=await locked(tx,market);
 const next=reserveOrder(prior,orderId);
 await save(tx,next);
 return {dollars:wagerDollars(prior),state:next};
}
export async function recordMarketFill(tx:Tx,market:MarketLadder,orderId:string,settlementId:string):Promise<void>{
 await save(tx,markFilled(await locked(tx,market),orderId,settlementId));
}
export async function recordMarketNoFill(tx:Tx,market:MarketLadder,orderId:string):Promise<void>{
 await save(tx,releaseNoFill(await locked(tx,market),orderId));
}
export async function recordMarketSettlement(tx:Tx,market:MarketLadder,settlementId:string,outcome:LadderOutcome):Promise<LadderState>{
 const current=await locked(tx,market);
 // The event ledger is the durable idempotency key, including for old
 // settlements replayed after a newer settlement.
 const seen=await tx.execute(sql`SELECT event_id FROM market_six_step_events WHERE market=${market} AND settlement_id=${settlementId} AND transition IN ('WIN','LOSS') LIMIT 1`);
 if(rowValue(seen))return current;
 const next=settle(current,settlementId,outcome);
 if(next!==current){
   await tx.execute(sql`INSERT INTO market_six_step_events(market,settlement_id,transition,prior_step,next_step) VALUES(${market},${settlementId},${outcome},${current.step},${next.step})`);
   await save(tx,next);
 }
 return next;
}

/**
 * Atomic entry points for callers that own a Drizzle database connection.
 * This deliberately does not perform any external Kalshi POST within a DB
 * transaction. Reserve and commit first, then submit. On uncertain responses
 * leave reservation held pending exchange reconciliation.
 */
export type LadderDatabase = {
 transaction:<T>(work:(tx:Tx)=>Promise<T>)=>Promise<T>;
};
export async function claimMarketWager(
 db:LadderDatabase,market:MarketLadder,orderId:string
):Promise<{dollars:number;state:LadderState}>{
 return db.transaction(tx=>reserveMarketLadder(tx,market,orderId));
}
export async function finalizeMarketFill(
 db:LadderDatabase,market:MarketLadder,orderId:string,settlementId:string
):Promise<void>{
 return db.transaction(tx=>recordMarketFill(tx,market,orderId,settlementId));
}
export async function finalizeMarketZeroFill(
 db:LadderDatabase,market:MarketLadder,orderId:string
):Promise<void>{
 return db.transaction(tx=>recordMarketNoFill(tx,market,orderId));
}
export async function applyVerifiedMarketSettlement(
 db:LadderDatabase,market:MarketLadder,settlementId:string,outcome:LadderOutcome
):Promise<LadderState>{
 return db.transaction(tx=>recordMarketSettlement(tx,market,settlementId,outcome));
}
