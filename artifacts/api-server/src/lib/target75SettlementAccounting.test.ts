import assert from "node:assert/strict";
import test from "node:test";
import { applyTarget75LotExit } from "./target75SettlementAccounting.js";

test("two partial ETH exits preserve residual exposure and cumulative P&L",()=>{
  const initial={originalContracts:4,exitedContracts:0,entryCostCents:200,
    entryFeeCents:4,realizedExitProceedsCents:0,realizedExitFeesCents:0};
  const first=applyTarget75LotExit(initial,{contracts:1,grossProceedsCents:75,feeCents:1});
  assert.equal(first.remainingContracts,3);
  assert.equal(first.totalRealizedProfitNumerator,92);
  const second=applyTarget75LotExit(first,{contracts:3,grossProceedsCents:225,feeCents:3});
  assert.equal(second.remainingContracts,0);
  assert.equal(second.totalRealizedProfitNumerator,368);
  assert.equal(second.denominator,4);
});
test("duplicate or overflowing exit quantities are rejected",()=>{
  const initial={originalContracts:1,exitedContracts:1,entryCostCents:50,
    entryFeeCents:1,realizedExitProceedsCents:75,realizedExitFeesCents:1};
  assert.throws(()=>applyTarget75LotExit(initial,{contracts:1,grossProceedsCents:75,feeCents:1}));
});
