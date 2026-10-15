/**
 * Market-level six-step ladder state machine.
 * IMPORTANT: Pure logic ONLY. No order submission or deployment occurs here.
 * Integration must supply durable transactional compare-and-set and verified settlement records.
 */
export type MarketLadder = "BTC" | "ETH" | "EURUSD";
export type LadderOutcome = "WIN" | "LOSS";
export const SIX_STEP_DOLLARS = [1,2,4,8,16,32] as const;
export type LadderState = Readonly<{
 market: MarketLadder;
 step: number;
 pendingOrderId: string | null;
 pendingSettlementId: string | null;
 lastSettlementId: string | null;
 version: number;
}>;
export function initialLadder(market: MarketLadder): LadderState {
 return {market,step:0,pendingOrderId:null,pendingSettlementId:null,lastSettlementId:null,version:0};
}
export function wagerDollars(state:LadderState):number{
 if(!Number.isInteger(state.step)||state.step<0||state.step>=SIX_STEP_DOLLARS.length)throw Error("invalid ladder step");
 return SIX_STEP_DOLLARS[state.step];
}
/** Call under a durable per-market lock or an atomic versioned compare-and-set. */
export function reserveOrder(state:LadderState,orderId:string):LadderState{
 if(!orderId)throw Error("order ID required");
 if(state.pendingOrderId||state.pendingSettlementId)throw Error("market ladder is busy");
 return {...state,pendingOrderId:orderId,version:state.version+1};
}
/** Keep slot reserved after successful order submission until confirmed settlement. */
export function markFilled(state:LadderState,orderId:string,settlementId:string):LadderState{
 if(state.pendingOrderId!==orderId||!settlementId)throw Error("mismatched filled order");
 return {...state,pendingOrderId:null,pendingSettlementId:settlementId,version:state.version+1};
}
/** Only proven no-fill/cancellation releases an unfilled reservation. */
export function releaseNoFill(state:LadderState,orderId:string):LadderState{
 if(state.pendingOrderId!==orderId||state.pendingSettlementId)throw Error("cannot release uncertain or settled order");
 return {...state,pendingOrderId:null,version:state.version+1};
}
/** Requires confirmed exchange settlement, called atomically with persisted reconciliation. */
export function settle(state:LadderState,settlementId:string,outcome:LadderOutcome):LadderState{
 if(state.lastSettlementId===settlementId)return state; // idempotent duplicate delivery
 if(!settlementId||state.pendingSettlementId!==settlementId||state.pendingOrderId)throw Error("unmatched settlement");
 if(outcome!=="WIN"&&outcome!=="LOSS")throw Error("invalid outcome");
 const step=outcome==="WIN"?0:(state.step+1)%SIX_STEP_DOLLARS.length;
 return {...state,step,pendingSettlementId:null,lastSettlementId:settlementId,version:state.version+1};
}

/** Price-aware whole-contract sizing. Do not submit when one contract plus fee
 * is unaffordable. Caller supplies the verified all-in taker fee in cents.
 * Never round up: the total debit must remain within the current ladder stake.
 */
export function affordableContracts(
 state:LadderState,
 priceCents:number,
 feeCents:(contracts:number,priceCents:number)=>number,
 maxContracts=10000,
):{contracts:number;totalCents:number;feeCents:number}{
 if(!Number.isInteger(priceCents)||priceCents<1||priceCents>99)throw Error("invalid contract price");
 if(!Number.isInteger(maxContracts)||maxContracts<1||maxContracts>100000)throw Error("invalid contract cap");
 const budget=wagerDollars(state)*100;
 let best=0,bestFee=0;
 const upper=Math.min(maxContracts,Math.floor(budget/priceCents));
 for(let count=1;count<=upper;count++){
   const fee=feeCents(count,priceCents);
   if(!Number.isSafeInteger(fee)||fee<0)throw Error("invalid fee");
   if(count*priceCents+fee<=budget){best=count;bestFee=fee}
 }
 return {contracts:best,totalCents:best*priceCents+bestFee,feeCents:bestFee};
}
