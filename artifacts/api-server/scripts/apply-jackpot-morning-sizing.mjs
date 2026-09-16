#!/usr/bin/env node
import fs from "node:fs";

const file = "artifacts/api-server/src/lib/strategies/ethJackpotService.ts";
let source = fs.readFileSync(file, "utf8");

const constantAnchor = "export const JACKPOT_WAGER_CENTS = 1_000; // HARD live cap: $10 during validation.\n";
const constantReplacement = `export const JACKPOT_WAGER_CENTS = 10_000; // Approved fixed live J budget: $100.\n\nfunction jackpotEffectiveWagerCents(_nowMs = Date.now()): number {\n  return JACKPOT_WAGER_CENTS;\n}\n`;
if (!source.includes("function jackpotEffectiveWagerCents")) {
  if (!source.includes(constantAnchor)) throw new Error("J wager constant anchor missing");
  source = source.replace(constantAnchor, constantReplacement);
}

const contractsAnchor = "  return Math.floor(JACKPOT_WAGER_CENTS / JACKPOT_MAX_PRICE_CENTS);";
const contractsReplacement = "  return Math.floor(jackpotEffectiveWagerCents() / JACKPOT_MAX_PRICE_CENTS);";
if (!source.includes(contractsReplacement)) {
  if (!source.includes(contractsAnchor)) throw new Error("J contract sizing anchor missing");
  source = source.replace(contractsAnchor, contractsReplacement);
}

fs.writeFileSync(file, source);
console.log("Applied J approved fixed $100 wager budget");
