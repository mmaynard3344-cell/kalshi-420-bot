#!/usr/bin/env node
import fs from "node:fs";

const file = "artifacts/api-server/src/g4060ScalpIndex.ts";
let source = fs.readFileSync(file, "utf8");

// Service G production patch: exact-two reversal only, 4:00-7:59 AM ET,
// Monday/Tuesday/Wednesday/Friday/Saturday, flat $200 at 50c outside the
// approved 6:00-11:59 AM ET portfolio sizing window, where it is $300.
// No weather/regime veto and no loss progression.

const helperAnchor = "let busy = false;\nasync function tick(): Promise<void> {";
const helper = `function gEntryWindowAllowed(openMs: number): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    hour12: false,
  }).formatToParts(new Date(openMs));
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
  const rawHour = Number(parts.find((p) => p.type === "hour")?.value ?? NaN);
  const hour = rawHour === 24 ? 0 : rawHour;
  return Number.isFinite(hour)
    && hour >= 4
    && hour <= 7
    && weekday !== "Sun"
    && weekday !== "Thu";
}

function gEffectivePrincipalCents(nowMs = Date.now()): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    hour12: false,
  }).formatToParts(new Date(nowMs));
  const rawHour = Number(parts.find((p) => p.type === "hour")?.value ?? NaN);
  const hour = rawHour === 24 ? 0 : rawHour;
  return Number.isFinite(hour) && hour >= 6 && hour < 12 ? 30_000 : 20_000;
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
if (!source.includes(tickReplacement)) {
  if (!source.includes(tickAnchor)) throw new Error("G tick anchor missing");
  source = source.replace(tickAnchor, tickReplacement);
}

const startupAnchor = `    progression: "100-200-400_same_side_on_losses_reset_on_win_or_step3_loss",`;
const startupReplacement = `    progression: "flat_200_base_300_morning_no_loss_progression",
    entrySchedule: "04:00-07:59_America/New_York_excluding_Sun_Thu",
    morningSizing: "1.5x_06:00-11:59_America/New_York",
    regimeGate: "disabled",`;
if (!source.includes('progression: "flat_200_base_300_morning_no_loss_progression"')) {
  if (!source.includes(startupAnchor)) throw new Error("G startup anchor missing");
  source = source.replace(startupAnchor, startupReplacement);
}

fs.writeFileSync(file, source);
console.log("Applied G flat-$200 schedule with approved 1.5x 6am-noon ET sizing; weather gate disabled");
