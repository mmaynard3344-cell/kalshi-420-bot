#!/usr/bin/env node
import fs from "node:fs";

const file = "artifacts/api-server/src/g4060ScalpIndex.ts";
let source = fs.readFileSync(file, "utf8");

const importAnchor = 'import { currentEthServiceRole } from "./lib/strategies/ethServiceRole.js";';
const gateImport = 'import { evaluateGRegimeGate } from "./lib/strategies/gRegimeGate.js";';
if (!source.includes(gateImport)) {
  if (!source.includes(importAnchor)) throw new Error("G regime gate import anchor missing");
  source = source.replace(importAnchor, `${importAnchor}\n${gateImport}`);
}

const tickAnchor = `    const market = await discoverCurrentMarket();
    if (!market || Date.now() < market.openMs || Date.now() > market.openMs + ENTRY_WINDOW_MS) return;
    let state = await loadState();`;
const tickReplacement = `    const market = await discoverCurrentMarket();
    if (!market || Date.now() < market.openMs || Date.now() > market.openMs + ENTRY_WINDOW_MS) return;

    const regime = await evaluateGRegimeGate(market.openMs, market.ticker);
    if (!regime.allowEntries) {
      logger.info({ ticker: market.ticker, regimeState: regime.state, regimeAction: regime.action, regimeReason: regime.reason, metrics: regime.metrics },
        "G automatic regime gate blocking new entry");
      return;
    }

    let state = await loadState();`;
if (!source.includes(tickReplacement)) {
  if (!source.includes(tickAnchor)) throw new Error("G regime gate tick anchor missing");
  source = source.replace(tickAnchor, tickReplacement);
}

const startupAnchor = '    progression: "100-200-400_same_side_on_losses_reset_on_win_or_step3_loss",';
const startupReplacement = `${startupAnchor}\n    regimeGate: "automatic_1h_directional_efficiency_with_hysteresis",`;
if (!source.includes('regimeGate: "automatic_1h_directional_efficiency_with_hysteresis"')) {
  if (!source.includes(startupAnchor)) throw new Error("G regime gate startup anchor missing");
  source = source.replace(startupAnchor, startupReplacement);
}

fs.writeFileSync(file, source);
console.log("Applied G automatic regime gate patch");
