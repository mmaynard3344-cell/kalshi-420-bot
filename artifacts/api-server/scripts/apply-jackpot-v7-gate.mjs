#!/usr/bin/env node
import fs from "node:fs";

const file = "artifacts/api-server/src/lib/strategies/ethJackpotService.ts";
let source = fs.readFileSync(file, "utf8");

const start = source.indexOf("async function processCandidate(order: JackpotAOrder): Promise<void> {");
const end = source.indexOf("\nasync function settlementSweep(): Promise<void> {", start);
if (start < 0 || end < 0) throw new Error("J V7 processCandidate anchors missing");

const replacement = `async function processCandidate(order: JackpotAOrder): Promise<void> {
  // V7 Jackpot gate: deliberately rare. Use only information observable by +5s.
  // J never cancels, replaces, or otherwise mutates A.
  const observation = await claimCandidateObservation(order);
  if (observation !== "first") return;

  const waitUntil = async (targetMs: number) => {
    const delay = targetMs - Date.now();
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  };
  const readAZeroResting = async (): Promise<Record<string, unknown> | null> => {
    try {
      const raw = await getAExchangeOrder(order);
      const parsed = parseKalshiOrderResponse(raw, order.requestedContracts);
      const resting = parsed.orderStatus === "resting" || parsed.orderStatus === "open";
      return parsed.fillCountProvided && parsed.fillCount === 0 && resting ? raw : null;
    } catch {
      return null;
    }
  };

  await waitUntil(order.createdAtMs + 2_000);
  const aAt2 = await readAZeroResting();
  if (!aAt2) {
    await patchAttempt(order.id, { status: "no_trigger", reason: "v7_a_not_zero_resting_at_2s" });
    return;
  }
  const book2 = await recordSnapshot(order, "j_v7_plus_2s", aAt2);
  const ask2 = book2.lowestLevelCents;
  if (!Number.isInteger(ask2) || ask2 == null) {
    await patchAttempt(order.id, { status: "no_trigger", reason: "v7_book_unavailable_at_2s" });
    return;
  }

  await waitUntil(order.createdAtMs + 5_000);
  const aAt5 = await readAZeroResting();
  if (!aAt5) {
    await patchAttempt(order.id, { status: "no_trigger", reason: "v7_a_not_zero_resting_at_5s" });
    return;
  }
  const book5 = await recordSnapshot(order, "j_v7_plus_5s", aAt5);
  const ask5 = book5.lowestLevelCents;
  if (!Number.isInteger(ask5) || ask5 == null) {
    await patchAttempt(order.id, { status: "no_trigger", reason: "v7_book_unavailable_at_5s" });
    return;
  }

  const levels5 = parseOrderbookResponse(rawBook(book5), order.side)
    .map((x) => ({ priceCents: x.priceCents, contracts: x.contractsApprox }));
  const executable = sweepQuote(levels5, jackpotEffectiveWagerCents(), JACKPOT_MAX_PRICE_CENTS);
  const requiredContracts = jackpotContracts();
  const fullSizeExecutableAt75 = executable.contracts >= requiredContracts;
  const rise2to5 = ask5 - ask2;

  if (ask5 < 73 || rise2to5 < 2 || !fullSizeExecutableAt75) {
    await patchAttempt(order.id, {
      status: "no_trigger",
      reason: ask5 < 73 ? "v7_ask_below_73" : rise2to5 < 2 ? "v7_rise_below_2" : "v7_full_size_not_executable_at_75",
      bestAsk: ask5,
    });
    logger.info({ service: "J", strategy: "Jackpot", ticker: order.ticker, ask2, ask5, rise2to5,
      requiredContracts, executableContracts: executable.contracts }, "Jackpot V7 gate rejected");
    return;
  }

  // Final read-only race fence immediately before J submission. A remains untouched.
  const confirmed = await confirmAStillRestingZeroFill(order);
  if (!confirmed) {
    await patchAttempt(order.id, { status: "blocked", reason: "v7_a_not_still_resting_zero_fill" });
    return;
  }
  await patchAttempt(order.id, { status: "triggered", reason: "v7_5s_escape_gate", bestAsk: ask5 });
  logger.info({ service: "J", strategy: "Jackpot", ticker: order.ticker, side: order.side,
    ask2, ask5, rise2to5, requiredContracts, executableContracts: executable.contracts,
    maxPriceCents: JACKPOT_MAX_PRICE_CENTS }, "Jackpot V7 gate triggered");

  if (process.env["JACKPOT_LIVE_ENABLED"] !== "true") {
    await patchAttempt(order.id, { status: "shadow_trigger", reason: "live_disabled" });
    return;
  }
  await submitJackpot(order);
}
`;

source = source.slice(0, start) + replacement + source.slice(end);
if (!source.includes('reason: "v7_5s_escape_gate"')) throw new Error("J V7 gate patch failed");
fs.writeFileSync(file, source);
console.log("Applied J V7 gate: +5s ask>=73, +2-to-+5 rise>=2, full size executable<=75, A read-only");
