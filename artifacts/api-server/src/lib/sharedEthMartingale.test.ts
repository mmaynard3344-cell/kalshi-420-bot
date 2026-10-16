import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ETH_SHARED_STAKES_CENTS, nextStep, resolveClaim, wagerCents } from "./sharedEthMartingale";

describe("shared ETH martingale review logic", () => {
  it("has six capped budget steps", () => {
    assert.deepEqual([...ETH_SHARED_STAKES_CENTS],[100,200,400,800,1600,3200]);
    assert.throws(() => wagerCents(6));
  });
  it("advances on losses and resets after a last-step loss", () => {
    for (let step=0;step<5;step++) assert.equal(nextStep(step,"LOSS"),step+1);
    assert.equal(nextStep(5,"LOSS"),0);
  });
  it("resets on wins and never advances for zero fills", () => {
    for (let step=0;step<6;step++) {
      assert.equal(nextStep(step,"WIN"),0);
      assert.equal(nextStep(step,"ZERO_FILL"),step);
    }
  });
  it("rejects stale or mismatched settlements", () => {
    const state={step:2,activeClaimId:"claim-1",version:7};
    assert.throws(() => resolveClaim(state,"claim-other","LOSS"));
    assert.deepEqual(resolveClaim(state,"claim-1","LOSS"),{step:3,activeClaimId:null,version:8});
    assert.equal(state.step,2);
  });
});
