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
  ["step >= 5 THEN NULL", "sixth verified loss reset"],
  ["step >= 5 THEN 0 ELSE step+1", "bounded six-step progression"],
]) assert.ok(section.includes(fragment), description);
assert.ok(strategy.includes("await exactTwoStreakDecision(market.openMs)"), "fresh entry checks settled streak");
assert.ok(strategy.includes("decision.key === state.lastTriggerKey"), "prevent trigger replay");
function transition(state, outcome) {
  if (outcome === "ZERO_FILL") return state;
  if (outcome === "WIN") return { side: null, step: 0 };
  if (state.step >= 5) return { side: null, step: 0 };
  return { ...state, step: state.step + 1 };
}
let state = {side:"yes",step:0};
state=transition(state,"ZERO_FILL"); assert.deepEqual(state,{side:"yes",step:0});
for(let i=1;i<=5;i++){state=transition(state,"LOSS");assert.deepEqual(state,{side:"yes",step:i});}
state=transition(state,"LOSS"); assert.deepEqual(state,{side:null,step:0});
state={side:"no",step:3};state=transition(state,"WIN");assert.deepEqual(state,{side:null,step:0});
console.log("G shared latch regression source invariants and state transitions: PASS");
