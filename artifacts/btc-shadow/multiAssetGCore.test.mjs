import test from "node:test";
import assert from "node:assert/strict";
import { ASSET_SERIES, G_STAKES_CENTS, initialLadder, stakeCents, reserve, applyVerifiedResult, decideG, selectGMarket, WINDOW_MS } from "./multiAssetGCore.mjs";

test("BTC G parity: exact two streak followed by opposite side", () => {
  assert.deepEqual(decideG(["no","yes","yes"]), {fires:true,side:"no",reason:"signal"});
  assert.deepEqual(decideG(["yes","no","no"]), {fires:true,side:"yes",reason:"signal"});
  for(const outcomes of [["yes","yes","yes"],["no","yes","no"],["yes","no","yes"],["yes","yes"],["no",null,"no"]])
    assert.equal(decideG(outcomes).fires,false);
});
test("six-step stake sequence and independent reset/advance per asset", () => {
  const state = Object.fromEntries(Object.keys(ASSET_SERIES).map(asset=>[asset,initialLadder(asset)]));
  for(const [asset,starting] of Object.entries(state)){
    let current=starting;
    for(let i=0;i<6;i++){
      assert.equal(stakeCents(current),G_STAKES_CENTS[i]);
      const id=asset+"-"+i;
      current=reserve(current,id);
      assert.throws(()=>reserve(current,id),/pending/);
      current=applyVerifiedResult(current,id,"loss");
    }
    assert.equal(stakeCents(current),200);
    const won=applyVerifiedResult(reserve(current,asset+"-win"),asset+"-win","win");
    assert.equal(won.step,0);
    const noFill=applyVerifiedResult(reserve(won,asset+"-no-fill"),asset+"-no-fill","zero_fill");
    assert.equal(noFill.step,0);
  }
  assert.equal(state.SOL.key,"G:SOL");
  assert.equal(state.XRP.step,0);
  assert.notEqual(state.SOL.key,state.DOGE.key);
});
test("rejects unknown assets, unverified settlement and identity mismatch", () => {
  assert.throws(()=>initialLadder("BTC"),/unsupported/);
  const a=reserve(initialLadder("SOL"),"order-a");
  assert.throws(()=>applyVerifiedResult(a,"order-b","win"),/mismatch/);
  assert.throws(()=>applyVerifiedResult(a,"order-a","pending"),/unverified/);
  assert.throws(()=>stakeCents({...a,asset:"DOGE"}),/invalid/);
});
test("selects only active valid contracts from the named asset", () => {
  const start=Date.parse("2026-10-18T18:15:00Z");
  for(const [asset,series] of Object.entries(ASSET_SERIES)){
    const market={ticker:series+"-EXAMPLE",status:"active",open_time:new Date(start).toISOString(),
      close_time:new Date(start+WINDOW_MS).toISOString(),floor_strike:1.02};
    assert.equal(selectGMarket(asset,market,start+5000)?.ticker,market.ticker);
    assert.equal(selectGMarket(asset,{...market,ticker:"KXBTC15M-EXAMPLE"},start+5000),null);
    assert.equal(selectGMarket(asset,{...market,status:"initialized"},start+5000),null);
    assert.equal(selectGMarket(asset,{...market,floor_strike:null},start+5000),null);
    assert.equal(selectGMarket(asset,{...market,close_time:new Date(start+WINDOW_MS+1).toISOString()},start+5000),null);
    assert.equal(selectGMarket(asset,market,start+WINDOW_MS),null);
  }
});
