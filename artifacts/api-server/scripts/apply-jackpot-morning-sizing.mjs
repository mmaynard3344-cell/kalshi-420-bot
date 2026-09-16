#!/usr/bin/env node
import fs from "node:fs";

const file = "artifacts/api-server/src/lib/strategies/ethJackpotService.ts";
let source = fs.readFileSync(file, "utf8");

const constantAnchor = "export const JACKPOT_WAGER_CENTS = 1_000; // HARD live cap: $10 during validation.\n";
const constantReplacement = `export const JACKPOT_WAGER_CENTS = 1_000; // Base live budget: $10; 1.5x from 06:00-11:59 ET.\n\nfunction jackpotEffectiveWagerCents(nowMs = Date.now()): number {\n  const parts = new Intl.DateTimeFormat(\"en-US\", {\n    timeZone: \"America/New_York\",\n    hour: \"numeric\",\n    hour12: false,\n  }).formatToParts(new Date(nowMs));\n  const rawHour = Number(parts.find((part) => part.type === \"hour\")?.value ?? NaN);\n  const hour = rawHour === 24 ? 0 : rawHour;\n  return Number.isFinite(hour) && hour >= 6 && hour < 12\n    ? Math.round(JACKPOT_WAGER_CENTS * 1.5)\n    : JACKPOT_WAGER_CENTS;\n}\n`;
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
console.log("Applied J approved 1.5x wager budget from 06:00-11:59 America/New_York");
