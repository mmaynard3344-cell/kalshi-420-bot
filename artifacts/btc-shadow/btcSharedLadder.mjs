// Pure BTC ladder state machine. No live order side effects.
export const BTC_STAKES_CENTS = Object.freeze([100,200,400,800,1600,3200]);
export function initialBtcLadder() {
 return {step:0,pendingOrderId:null,pendingSettlementId:null,lastSettlementId:null,version:0};
}
export function stakeCents(state) {
 if(!Number.isInteger(state.step)||state.step<0||state.step>=6) throw Error("invalid BTC step");
 return BTC_STAKES_CENTS[state.step];
}
export function claim(state,id) {
 if(!id||state.pendingOrderId||state.pendingSettlementId)throw Error("BTC ladder busy or invalid order");
 return {...state,pendingOrderId:id,version:state.version+1};
}
export function confirmFill(state,id,settlementId){
 if(!settlementId||state.pendingOrderId!==id)throw Error("BTC fill not matched");
 return {...state,pendingOrderId:null,pendingSettlementId:settlementId,version:state.version+1};
}
export function confirmZeroFill(state,id){
 if(state.pendingOrderId!==id||state.pendingSettlementId)throw Error("BTC zero-fill not verified");
 return {...state,pendingOrderId:null,version:state.version+1};
}
export function confirmSettlement(state,id,result){
 if(state.lastSettlementId===id)return state;
 if(!id||state.pendingSettlementId!==id||!["WIN","LOSS"].includes(result))throw Error("BTC settlement not matched");
 return {...state,step:result==="WIN"?0:(state.step+1)%6,pendingSettlementId:null,lastSettlementId:id,version:state.version+1};
}
export function sizeBtcOrder(state,askCents,feeCents,maxContracts=10000){
 if(!Number.isInteger(askCents)||askCents<1||askCents>99)throw Error("invalid ask");
 const cap=stakeCents(state);
 let contracts=0,totalCents=0;
 for(let n=1;n<=Math.min(maxContracts,Math.floor(cap/askCents));n++){
   const fee=feeCents(n,askCents);
   if(!Number.isSafeInteger(fee)||fee<0)throw Error("invalid fee");
   if(n*askCents+fee<=cap){contracts=n;totalCents=n*askCents+fee}
 }
 return {contracts,totalCents};
}
