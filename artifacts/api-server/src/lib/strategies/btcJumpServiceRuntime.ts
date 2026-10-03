import { evaluateBtcJump, type BtcJumpFact, type BtcJumpMarket } from "./btcJumpSignal.js";

/** Read-only intent preparation. No A state or exchange submission is imported. */
export function prepareBtcJumpIntent(input: { market: BtcJumpMarket; history: readonly BtcJumpFact[] }) {
  const evaluation = evaluateBtcJump(input);
  const intent = evaluation.fires ? {
    strategy: "jump" as const,
    orderTag: "btc-jump-fixed-yes-v1",
    ticker: input.market.ticker,
    side: "yes" as const,
    wagerCents: 500,
    limitPriceCents: 50,
    marketOpenTimeMs: input.market.openTimeMs,
  } : null;
  return { evaluation, intent };
}
