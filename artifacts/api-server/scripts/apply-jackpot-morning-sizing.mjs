#!/usr/bin/env node
import fs from "node:fs";

const file = "artifacts/api-server/src/lib/strategies/ethJackpotService.ts";
let source = fs.readFileSync(file, "utf8");

// Reduced-bankroll live smoke test: J is fixed at a $1 maximum IOC budget.
// Keep this as a build-time enforcement layer so Docker rebuilds cannot restore
// the historical $100 sizing.
const wagerPattern = /export const JACKPOT_WAGER_CENTS = [^;]+;[^\n]*/;
if (!wagerPattern.test(source)) throw new Error("J wager constant anchor missing");
source = source.replace(
  wagerPattern,
  "export const JACKPOT_WAGER_CENTS = 100; // Reduced live test cap: $1.",
);

if (!source.includes("function jackpotEffectiveWagerCents")) {
  const anchor = "export const JACKPOT_WAGER_CENTS = 100; // Reduced live test cap: $1.\n";
  if (!source.includes(anchor)) throw new Error("J reduced wager anchor missing");
  source = source.replace(
    anchor,
    anchor + "\nfunction jackpotEffectiveWagerCents(_nowMs = Date.now()): number {\n  return JACKPOT_WAGER_CENTS;\n}\n",
  );
}

const oldContracts = "  return Math.floor(JACKPOT_WAGER_CENTS / JACKPOT_MAX_PRICE_CENTS);";
const newContracts = "  return Math.floor(jackpotEffectiveWagerCents() / JACKPOT_MAX_PRICE_CENTS);";
if (source.includes(oldContracts)) source = source.replace(oldContracts, newContracts);
else if (!source.includes(newContracts)) throw new Error("J contract sizing anchor missing");

fs.writeFileSync(file, source);
console.log("Applied J reduced fixed $1 wager budget");
