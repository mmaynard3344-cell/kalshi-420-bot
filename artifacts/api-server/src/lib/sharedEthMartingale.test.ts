import { describe, expect, it } from "vitest";
import { ETH_SHARED_STAKES_CENTS, nextStep, resolveClaim, wagerCents } from "./sharedEthMartingale";

describe("shared ETH martingale review logic", () => {
  it("has six capped budget steps", () => {
    expect([...ETH_SHARED_STAKES_CENTS]).toEqual([100,200,400,800,1600,3200]);
    expect(() => wagerCents(6)).toThrow();
  });
  it("advances on losses and resets after a last-step loss", () => {
    for (let step=0;step<5;step++) expect(nextStep(step,"LOSS")).toBe(step+1);
    expect(nextStep(5,"LOSS")).toBe(0);
  });
  it("resets on wins and never advances for zero fills", () => {
    for (let step=0;step<6;step++) {
      expect(nextStep(step,"WIN")).toBe(0);
      expect(nextStep(step,"ZERO_FILL")).toBe(step);
    }
  });
  it("rejects stale or mismatched settlements", () => {
    const state={step:2,activeClaimId:"claim-1",version:7};
    expect(() => resolveClaim(state,"claim-other","LOSS")).toThrow();
    expect(resolveClaim(state,"claim-1","LOSS")).toEqual({step:3,activeClaimId:null,version:8});
    expect(state.step).toBe(2);
  });
});
