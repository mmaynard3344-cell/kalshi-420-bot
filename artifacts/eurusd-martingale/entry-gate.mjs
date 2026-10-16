import {getUsdLadder,hasUnresolvedUsdOrders} from './store.mjs';
import {reconcileUsdLadder} from './reconcile.mjs';
/**
 * Live USD entry gate, to be called before calculating contract count.
 * Fails closed. No submission and no simulated outcome can alter the ladder.
 */
export async function prepareUsdEntry(db,api) {
  const reconciliation=await reconcileUsdLadder(db,api);
  if(!reconciliation.ready || hasUnresolvedUsdOrders(db)) {
    return {allowed:false,reason:reconciliation.reason??'UNRESOLVED_ORDER',budgetCents:null};
  }
  const state=getUsdLadder(db);
  return {allowed:true,step:state.step,budgetCents:state.budgetCents,version:state.version};
}
export function validateUsdOrderBudget(prepared,requestedCostCents) {
  return Boolean(prepared?.allowed && Number.isInteger(requestedCostCents) &&
    requestedCostCents>0 && requestedCostCents<=prepared.budgetCents);
}
