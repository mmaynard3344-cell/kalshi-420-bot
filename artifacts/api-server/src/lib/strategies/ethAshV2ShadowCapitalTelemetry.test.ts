import assert from "node:assert/strict";
import test from "node:test";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildEthAshV2ShadowCapitalEvent,
  type EthAshV2ShadowCapitalInput,
} from "./ethAshV2ShadowCapitalTelemetry.js";

const baseInput: EthAshV2ShadowCapitalInput = {
  strategy: "ash_v2_i",
  ticker: "KXETH15M-TEST",
  exchangeIndex: 2,
  requestedRiskCents: 77,
  oldPolicyDecision: "capital_blocked",
  oldPolicyBlocker: "insufficient_unreserved_capital",
  proposedAvailableBalanceCents: 77,
  proposedInflightReservedCents: 0,
  timestamp: 1_700_000_000_000,
  deploymentVersion: "test-commit",
};

test("I shadow allow never changes the old capital-blocked enforcement result", () => {
  const event = buildEthAshV2ShadowCapitalEvent(baseInput);
  assert.equal(event.proposed_policy_decision, "shadow_allow");
  assert.equal(event.would_have_admitted, true);
  assert.equal(event.proposed_free_capital_cents, 77);
  assert.equal(event.old_policy_decision, "capital_blocked");
  assert.equal(event.old_policy_blocker, "insufficient_unreserved_capital");
});

test("I shadow policy blocks when proposed free capital is one cent short", () => {
  const event = buildEthAshV2ShadowCapitalEvent({
    ...baseInput,
    proposedAvailableBalanceCents: 76,
  });
  assert.equal(event.proposed_policy_decision, "shadow_block");
  assert.equal(event.would_have_admitted, false);
  assert.equal(event.proposed_free_capital_cents, 76);
  assert.equal(event.old_policy_decision, "capital_blocked");
});

test("I shadow policy is unavailable when balance facts are missing", () => {
  const event = buildEthAshV2ShadowCapitalEvent({
    ...baseInput,
    proposedAvailableBalanceCents: null,
    proposedInflightReservedCents: null,
  });
  assert.equal(event.proposed_policy_decision, "shadow_unavailable");
  assert.equal(event.would_have_admitted, false);
  assert.equal(event.proposed_free_capital_cents, null);
  assert.equal(event.old_policy_decision, "capital_blocked");
});

test("I shadow event preserves strategy, routing, risk, timestamp, and deployment facts", () => {
  const event = buildEthAshV2ShadowCapitalEvent(baseInput);
  assert.deepEqual(event, {
    service: "I",
    strategy: "ash_v2_i",
    ticker: "KXETH15M-TEST",
    exchange_index: 2,
    requested_risk_cents: 77,
    old_policy_decision: "capital_blocked",
    old_policy_blocker: "insufficient_unreserved_capital",
    proposed_available_balance_cents: 77,
    proposed_inflight_reserved_cents: 0,
    proposed_free_capital_cents: 77,
    proposed_policy_decision: "shadow_allow",
    would_have_admitted: true,
    timestamp: 1_700_000_000_000,
    deployment_version: "test-commit",
  });
});

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(full));
    else out.push(full);
  }
  return out;
}

test("no non-test application source imports the I shadow adapter", async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const srcRoot = path.resolve(here, "../../..");
  const files = (await walk(srcRoot))
    .filter((file) => /\.(ts|mts|cts|js|mjs|cjs)$/.test(file))
    .filter((file) => !file.endsWith("ethAshV2ShadowCapitalTelemetry.ts"))
    .filter((file) => !file.endsWith("ethAshV2ShadowCapitalTelemetry.test.ts"));

  const importingFiles: string[] = [];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    if (source.includes("ethAshV2ShadowCapitalTelemetry")) importingFiles.push(file);
  }
  assert.deepEqual(importingFiles, []);
});
