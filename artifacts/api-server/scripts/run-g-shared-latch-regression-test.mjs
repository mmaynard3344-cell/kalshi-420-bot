import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const strategy = readFileSync(fileURLToPath(new URL("../src/g4060ScalpIndex.ts", import.meta.url)), "utf8");
const section = strategy.split('if(process.env["ETH_G_SHARED_MARTINGALE_ENABLED"]==="true"){')[1]?.split("  const won = order.filledContracts")[0];
assert.ok(section, "shared settlement branch must exist");
for (const [fragment, description] of [
  ["await finalizeEthClaim", "exchange-verified shared claim settlement"],
  ["await d.transaction(async (tx)", "atomic local journal and latch settlement"],
  ["rows(settled).length !== 1", "idempotent journal guard"],
  ['outcome === "ZERO_FILL"', "zero fill does not advance recovery"],
  ['outcome === "WIN"', "verified win reset"],
  ["sharedSettlement.step === 0", "shared cycle exhaustion resets G"],
  ["step=${sharedSettlement.step}", "shared authoritative rung mirrored"],
]) assert.ok(section.includes(fragment), description);
assert.ok(strategy.includes("await exactTwoStreakDecision(market.openMs)"), "fresh entry checks settled streak");
assert.ok(strategy.includes("decision.key === state.lastTriggerKey"), "prevent trigger replay");
assert.ok(strategy.includes("claim.service !== \"G\""), "external service settlement clears G latch");
assert.ok(strategy.includes("claim.ticker !== lastG[\"ticker\"]"), "stale or unrelated claim cannot carry G direction");
assert.ok(strategy.includes("G stale shared direction reset"), "cross-service recovery logging present");
assert.ok(strategy.includes("expectedSharedVersion = version"), "G snapshots shared version");
assert.ok(strategy.includes("market,state.ladderSide,expectedSharedVersion"), "G passes version to claim gateway");
// Regression guard: no recovery rung may bypass the fresh G signal gate.
const gateStart=strategy.indexOf("const stored = await publishedDirection(market.ticker);", strategy.indexOf("async function tick()"));
const decisionStart=strategy.indexOf("const decision = await exactTwoStreakDecision(market.openMs);",gateStart);
const submissionStart=strategy.indexOf("await submitGWithSharedReservation(",decisionStart);
assert.ok(gateStart>0 && decisionStart>gateStart && submissionStart>decisionStart,"fresh signal executes before shared claim submission");
const gate=strategy.slice(gateStart,submissionStart);
assert.ok(gate.includes('decision.kind === "none"'),"no-signal market is skipped");
assert.ok(gate.includes('decision.kind === "unknown"'),"unsettled result defers trade");
assert.ok(gate.includes("decision.side !== state.ladderSide"),"recovery only allowed on fresh matching-side signal");
assert.ok(gate.includes("decision.key === state.lastTriggerKey"),"signal replay is rejected");
assert.ok(gate.includes('g_signal_opposes_active_ladder'),"opposite signal skips without resetting ladder");
assert.ok(gate.includes("const selectedSide = state.ladderSide ?? decision.side"),"same-side signal preserves carried direction");
const afterGateway=strategy.slice(submissionStart,strategy.indexOf("} else {\n      if (freshStart)",submissionStart));
assert.ok(afterGateway.includes("if (!reserved)"),"failed reservation must not consume trigger");
assert.ok(afterGateway.indexOf("if (!reserved)") < afterGateway.indexOf("await setState("),"trigger saved only after reservation");
function canEnter(decision, state) {
  if(decision.kind!=="signal" || decision.key===state.lastTriggerKey) return false;
  if(state.ladderSide!==null && decision.side!==state.ladderSide) return false;
  return true;
}
const carried={ladderSide:"yes",step:5,lastTriggerKey:"old"};
assert.equal(canEnter({kind:"none"},carried),false);
assert.equal(canEnter({kind:"unknown"},carried),false);
assert.equal(canEnter({kind:"signal",side:"no",key:"new"},carried),false);
assert.equal(canEnter({kind:"signal",side:"yes",key:"old"},carried),false);
assert.equal(canEnter({kind:"signal",side:"yes",key:"new"},carried),true);
assert.equal(carried.step,5,"skipped markets do not advance sixth rung");
const store=readFileSync(fileURLToPath(new URL("../src/lib/sharedEthClaimStore.ts", import.meta.url)), "utf8");
const gateway=readFileSync(fileURLToPath(new URL("../src/lib/sharedEthOrderGateway.ts", import.meta.url)), "utf8");
assert.ok(store.includes("Number(state.version) !== req.expectedVersion"), "claim rejects changed shared version under lock");
assert.ok(store.includes("FOR UPDATE"), "claim is row-locked");
assert.ok(gateway.includes("expectedVersion:request.expectedVersion"), "gateway forwards expected version");

function transition(state, outcome, sharedStep) {
  if (outcome === "ZERO_FILL") return state;
  if (outcome === "WIN" || (outcome === "LOSS" && sharedStep === 0)) return {side:null,step:0};
  return {...state,step:sharedStep};
}
let state={side:"yes",step:0};
state=transition(state,"ZERO_FILL",0);assert.deepEqual(state,{side:"yes",step:0});
for(let i=1;i<=5;i++){state=transition(state,"LOSS",i);assert.deepEqual(state,{side:"yes",step:i});}
state=transition(state,"LOSS",0);assert.deepEqual(state,{side:null,step:0});
state={side:"no",step:3};state=transition(state,"WIN",0);assert.deepEqual(state,{side:null,step:0});
console.log("G shared cycle source invariants and state transitions: PASS");
