/** Read-only description of research retention policy; never used by trading. */
export function getResearchRetentionStatus() {
  const legacyRawEnabled = process.env["LEGACY_RAW_RESEARCH_CAPTURE_ENABLED"] === "true";
  return {
    rawResearchRetention: legacyRawEnabled ? "legacy_opt_in" : "disabled_by_default",
    compactDerivedCollectors: {
      sol: "analysis/sol-coinbase-target-capture.mjs",
      btcEth: "analysis/btc-eth-coinbase-target-capture.mjs",
    },
    rawTickPersistence: false,
    retainedOperationalEvidence: [
      "orders", "fills", "fees", "positions", "settlements", "ownership",
      "recovery", "safety_guards", "preflight_evidence",
    ],
    executionGate: false,
  };
}