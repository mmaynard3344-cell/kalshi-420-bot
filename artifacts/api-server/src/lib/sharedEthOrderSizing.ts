/** Shared ETH order sizing; never exceed the reserved principal budget.
 * Fee estimates must be conservative; reject an order if one contract cannot fit.
 * Pure review-only helper: no live caller until all ETH services are covered.
 */
export function ethContractsWithinBudget(
 budgetCents:number,
 priceCents:number,
 estimatedFeeCents:(contracts:number)=>number,
):{contracts:number;principalCents:number;feeCents:number;totalCents:number}{
 if(!Number.isSafeInteger(budgetCents)||budgetCents<0)throw Error("invalid ETH budget");
 if(!Number.isSafeInteger(priceCents)||priceCents<1||priceCents>99)throw Error("invalid ETH price");
 let winner={contracts:0,principalCents:0,feeCents:0,totalCents:0};
 for(let contracts=1;contracts<=Math.floor(budgetCents/priceCents);contracts++){
   const principalCents=contracts*priceCents;
   const feeCents=estimatedFeeCents(contracts);
   if(!Number.isSafeInteger(feeCents)||feeCents<0)throw Error("invalid estimated fee");
   const totalCents=principalCents+feeCents;
   if(totalCents>budgetCents)break;
   winner={contracts,principalCents,feeCents,totalCents};
 }
 return winner;
}
