#!/usr/bin/env node
import fs from "node:fs";

const file = "artifacts/api-server/src/g4060ScalpIndex.ts";
let source = fs.readFileSync(file, "utf8");

// Service G production patch: exact-two reversal only, all hours/all days.
// Preserve approved time-based sizing only; time must never gate eligibility.
// No weather/regime veto and no loss progression.

const helperAnchor = "let busy = false;\nasync function tick(): Promise<void> {";
const helper = `function gEntryWindowAllowed(_openMs: number): boolean {
  return true;
}

function gEffectivePrincipalCents(nowMs = Date.now()): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    hour12: false,
  }).formatToParts(new Date(nowMs));
  const rawHour = Number(parts.find((p) => p.type === "hour")?.value ?? NaN);
  const hour = rawHour === 24 ? 0 : rawHour;
  return 500;
}

let busy = false;
async function tick(): Promise<void> {`;
if (!source.includes("function gEntryWindowAllowed")) {
  if (!source.includes(helperAnchor)) throw new Error("G schedule helper anchor missing");
  source = source.replace(helperAnchor, helper);
}

const submitSizingAnchor = `  const principalCents = PRINCIPALS_CENTS[step]!;
  const contracts = CONTRACTS[step]!;`;
const submitSizingReplacement = `  const principalCents = gEffectivePrincipalCents();
  const contracts = Math.floor(principalCents / LIMIT_PRICE_CENTS);`;
if (!source.includes(submitSizingReplacement)) {
  if (!source.includes(submitSizingAnchor)) throw new Error("G sizing anchor missing");
  source = source.replace(submitSizingAnchor, submitSizingReplacement);
}

const settlementAnchor = `    if (order.filledContracts <= 0) return;
    if (won) {
      await tx.execute(sql\`
        UPDATE eth_g_streak_reversal_state
        SET ladder_side=NULL, step=0, updated_at_ms=\${Date.now()} WHERE id=1
      \`);
      return;
    }
    if (order.step < 2) {
      await tx.execute(sql\`
        UPDATE eth_g_streak_reversal_state
        SET ladder_side=\${order.side}, step=\${order.step + 1}, updated_at_ms=\${Date.now()} WHERE id=1
      \`);
    } else {
      await tx.execute(sql\`
        UPDATE eth_g_streak_reversal_state
        SET ladder_side=NULL, step=0, updated_at_ms=\${Date.now()} WHERE id=1
      \`);
    }`;
const settlementReplacement = `    if (order.filledContracts <= 0) return;
    await tx.execute(sql\`
      UPDATE eth_g_streak_reversal_state
      SET ladder_side=NULL, step=0, updated_at_ms=\${Date.now()} WHERE id=1
    \`);`;
if (!source.includes(settlementReplacement)) {
  if (!source.includes(settlementAnchor)) throw new Error("G settlement progression anchor missing");
  source = source.replace(settlementAnchor, settlementReplacement);
}

// G publisher releases carry an immutable market decision table. Keep the
// deployed flat, one-shot exact-two signal policy while publishing its side
// before the exchange order. Other workers wait for this row.
if (source.includes("async function publishedDirection(") && !source.includes('"g_flat_streak_direction"')) {
  const tickStart = source.indexOf("async function tick(): Promise<void>");
  const begin = source.indexOf("    const market = await discoverCurrentMarket();", tickStart);
  const oldSubmit = "    await submitOrder(market, state.ladderSide, state.step);";
  const finish = source.indexOf(oldSubmit, begin);
  if (begin < 0 || finish < 0) throw new Error("G publisher flat tick anchor missing");
  const replacement = `    const market = await discoverCurrentMarket();
    if (!market || Date.now() < market.openMs || Date.now() > market.openMs + ENTRY_WINDOW_MS) return;
    if (!gEntryWindowAllowed(market.openMs)) return;

    // A ticker decision is immutable. Once published, G's one-shot entry for
    // that market has already been attempted (or conclusively has no signal).
    const published = await publishedDirection(market.ticker);
    if (published.exists) return;

    const state = await loadState();
    const decision = await exactTwoStreakDecision(market.openMs);
    if (decision.kind === "unknown") return;
    if (decision.kind === "none" || decision.key === state.lastTriggerKey) {
      await publishDirection(market.ticker, null, "no_eligible_g_streak");
      return;
    }

    await setState(null, 0, decision.key);
    if (!await publishDirection(market.ticker, decision.side, "g_flat_streak_direction")) return;
    logger.info({ ticker: market.ticker, priorResult: decision.priorResult, side: decision.side, triggerKey: decision.key, principalCents: gEffectivePrincipalCents() },
      "G flat scheduled exact-two reversal trigger armed");
    await submitOrder(market, decision.side, 0);`;
  source = source.slice(0, begin) + replacement + source.slice(finish + oldSubmit.length);
}

const tickAnchor = `    const market = await discoverCurrentMarket();
    if (!market || Date.now() < market.openMs || Date.now() > market.openMs + ENTRY_WINDOW_MS) return;
    let state = await loadState();

    if (state.ladderSide == null) {
      const trigger = await exactTwoStreakTrigger(market.openMs);
      if (!trigger || trigger.key === state.lastTriggerKey) return;
      await setState(trigger.side, 0, trigger.key);
      state = { ladderSide: trigger.side, step: 0, lastTriggerKey: trigger.key };
      logger.info({ ticker: market.ticker, priorResult: trigger.priorResult, side: trigger.side, triggerKey: trigger.key },
        "G streak reversal two-consecutive-side trigger armed");
    }

    await submitOrder(market, state.ladderSide, state.step);`;
const tickReplacement = `    const market = await discoverCurrentMarket();
    if (!market || Date.now() < market.openMs || Date.now() > market.openMs + ENTRY_WINDOW_MS) return;
    if (!gEntryWindowAllowed(market.openMs)) return;

    const state = await loadState();
    const trigger = await exactTwoStreakTrigger(market.openMs);
    if (!trigger || trigger.key === state.lastTriggerKey) return;

    await setState(null, 0, trigger.key);
    logger.info({ ticker: market.ticker, priorResult: trigger.priorResult, side: trigger.side, triggerKey: trigger.key, principalCents: gEffectivePrincipalCents() },
      "G flat scheduled exact-two reversal trigger armed");
    await submitOrder(market, trigger.side, 0);`;
if (!source.includes("async function publishedDirection(") && !source.includes(tickReplacement)) {
  if (!source.includes(tickAnchor)) throw new Error("G tick anchor missing");
  source = source.replace(tickAnchor, tickReplacement);
}

const startupAnchor = `    progression: "500-500-500_flat_same_side_on_losses_reset_on_win_or_step3_loss",`;
const startupReplacement = `    progression: "flat_500_no_loss_progression",
    morningSizing: "disabled",
    regimeGate: "disabled",`;
if (!source.includes('progression: "flat_200_base_300_morning_no_loss_progression"')) {
  if (!source.includes(startupAnchor)) throw new Error("G startup anchor missing");
  source = source.replace(startupAnchor, startupReplacement);
}

fs.writeFileSync(file, source);
console.log("Applied G all-hours/all-days eligibility with flat 500-cent sizing; weather gate disabled");
