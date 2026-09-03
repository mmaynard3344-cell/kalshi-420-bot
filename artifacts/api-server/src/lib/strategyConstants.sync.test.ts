/**
 * strategyConstants.sync.test.ts — guards the OWNER-LOCKED strategy constants.
 *
 * Two jobs:
 *
 *  1. Pin the canonical values in autoTraderGuards.ts to the owner-approved
 *     numbers. If any of these assertions fails, someone changed a live
 *     trading rule — that requires explicit owner approval and a
 *     STRATEGY_VERSION bump (see the owner-lock banner in autoTraderGuards.ts).
 *
 *  2. Verify the mirrored literal copies in restingOrderSim.ts and
 *     passiveObserver.ts (kept local there to avoid circular imports) match
 *     the canonical values, so a future "drift fix" cannot silently pick the
 *     wrong value. Also verifies autoTrader.ts SERIES_CONFIG references
 *     the explicit BTC/ETH cap constants rather than numeric literals.
 *
 * Mirrors are checked by reading the SOURCE TEXT (not importing) because
 * those modules pull in pino/SQL dependencies and their constants are not
 * exported. The test runner executes from the api-server package root, so
 * paths resolve via process.cwd().
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  TIME_ALERT_SECONDS,
  PRICE_FLOOR_CENTS,
  PRICE_CAP_CENTS,
  ALERT_MIN,
  ALERT_MAX,
  BTC_BET_DOLLARS,
  BTC_ENTRY_FLOOR_CENTS,
  BTC_ENTRY_CAP_CENTS,
  ETH_BET_DOLLARS,
  ETH_ENTRY_FLOOR_CENTS,
  ETH_ENTRY_CAP_CENTS,
} from "./autoTraderGuards.js";
import {
  ALERT_MIN as GATE_ALERT_MIN,
  ALERT_MAX as GATE_ALERT_MAX,
} from "./preflightGate.js";
import { STRATEGY_CONFIG, STRATEGY_VERSION } from "../strategy/decide.js";

const SRC = (rel: string) =>
  readFileSync(join(process.cwd(), "src", rel), "utf8");

function extractConst(source: string, name: string, file: string): number {
  const m = source.match(new RegExp(`const\\s+${name}\\s*=\\s*(\\d+)`));
  assert.ok(m, `${file}: expected a literal "const ${name} = <number>" mirror`);
  return Number(m![1]);
}

describe("OWNER-LOCKED strategy constants", () => {
  it("canonical values match the owner-approved numbers", () => {
    // If one of these fails, a live trading rule changed. Do NOT update the
    // expected value here without explicit owner approval in the chat AND a
    // STRATEGY_VERSION bump in src/strategy/decide.ts.
    assert.equal(TIME_ALERT_SECONDS, 120);
    assert.equal(ALERT_MIN, 90);
    assert.equal(ALERT_MAX, 95);
    assert.equal(PRICE_FLOOR_CENTS, 90);
    assert.equal(PRICE_CAP_CENTS, 95);
    assert.equal(BTC_BET_DOLLARS, 1);
    assert.equal(BTC_ENTRY_FLOOR_CENTS, 90);
    assert.equal(BTC_ENTRY_CAP_CENTS, 95);
    assert.equal(ETH_BET_DOLLARS, 1);
    assert.equal(ETH_ENTRY_FLOOR_CENTS, 90);
    assert.equal(ETH_ENTRY_CAP_CENTS, 95);
  });

  it("preflightGate re-exports the canonical entry zone (no redefinition)", () => {
    assert.equal(GATE_ALERT_MIN, ALERT_MIN);
    assert.equal(GATE_ALERT_MAX, ALERT_MAX);
    const gateSrc = SRC("lib/preflightGate.ts");
    assert.ok(
      !/const\s+ALERT_(MIN|MAX)\s*=\s*\d+/.test(gateSrc),
      "preflightGate.ts must not redefine ALERT_MIN/ALERT_MAX with literals",
    );
  });

  it("decide.ts STRATEGY_CONFIG mirrors the canonical values", () => {
    assert.equal(STRATEGY_CONFIG.ALERT_MIN, ALERT_MIN);
    assert.equal(STRATEGY_CONFIG.ALERT_MAX, ALERT_MAX);
    assert.equal(STRATEGY_CONFIG.TIME_ALERT_SECONDS, TIME_ALERT_SECONDS);
  });

  it("restingOrderSim.ts mirrored literals are in sync", () => {
    const src = SRC("routes/restingOrderSim.ts");
    assert.equal(extractConst(src, "ALERT_MIN", "restingOrderSim.ts"), ALERT_MIN);
    assert.equal(extractConst(src, "ALERT_MAX", "restingOrderSim.ts"), ALERT_MAX);
    assert.equal(
      extractConst(src, "TIME_ALERT_SECONDS", "restingOrderSim.ts"),
      TIME_ALERT_SECONDS,
    );
  });

  it("passiveObserver.ts mirrored literals are in sync", () => {
    const src = SRC("lib/passiveObserver.ts");
    assert.equal(extractConst(src, "ALERT_MIN", "passiveObserver.ts"), ALERT_MIN);
    assert.equal(extractConst(src, "ALERT_MAX", "passiveObserver.ts"), ALERT_MAX);
  });

  it("STRATEGY_CONFIG changes require a STRATEGY_VERSION bump", () => {
    // Snapshot of STRATEGY_CONFIG keyed by STRATEGY_VERSION. If the config
    // changes, this test fails until STRATEGY_VERSION is bumped AND a new
    // snapshot entry is added here (with owner approval — see the owner-lock
    // banner in autoTraderGuards.ts). Never edit an existing entry.
    const VERSION_SNAPSHOTS: Record<string, Record<string, number>> = {
      "1.3.0": {
        ALERT_MIN: 70,
        ALERT_MAX: 82,
        TIME_ALERT_SECONDS: 120,
        LIMIT_PRICE_BUFFER_CENTS: 1,
      },
      // 1.3.1: no constant VALUE changed — STRATEGY_CONFIG was extended to
      // also pin BET_DOLLARS / PRICE_FLOOR_CENTS / PRICE_CAP_CENTS so those
      // owner-locked constants can no longer change without a version bump.
      "1.3.1": {
        ALERT_MIN: 70,
        ALERT_MAX: 82,
        TIME_ALERT_SECONDS: 120,
        LIMIT_PRICE_BUFFER_CENTS: 1,
        BET_DOLLARS: 600,
        PRICE_FLOOR_CENTS: 70,
        PRICE_CAP_CENTS: 95,
      },
      // 1.4.0: owner-approved 2026-08-02 — BET_DOLLARS reduced 600 → 10 while
      // investigating two straight overnight BTC losses (falling-knife entries).
      "1.4.0": {
        ALERT_MIN: 70,
        ALERT_MAX: 82,
        TIME_ALERT_SECONDS: 120,
        LIMIT_PRICE_BUFFER_CENTS: 1,
        BET_DOLLARS: 10,
        PRICE_FLOOR_CENTS: 70,
        PRICE_CAP_CENTS: 95,
      },
      // 1.4.1: owner-approved 2026-08-02 — TIME_ALERT_SECONDS widened 120 → 150
      // (entry window expanded from last 2:00 to last 2:30 before close).
      "1.4.1": {
        ALERT_MIN: 70,
        ALERT_MAX: 82,
        TIME_ALERT_SECONDS: 150,
        LIMIT_PRICE_BUFFER_CENTS: 1,
        BET_DOLLARS: 10,
        PRICE_FLOOR_CENTS: 70,
        PRICE_CAP_CENTS: 95,
      },
      // 1.4.2: owner-approved 2026-08-02 — TIME_ALERT_SECONDS widened 150 → 180
      // (entry window expanded from last 2:30 to last 3:00 before close).
      "1.4.2": {
        ALERT_MIN: 70,
        ALERT_MAX: 82,
        TIME_ALERT_SECONDS: 180,
        LIMIT_PRICE_BUFFER_CENTS: 1,
        BET_DOLLARS: 10,
        PRICE_FLOOR_CENTS: 70,
        PRICE_CAP_CENTS: 95,
      },
      // 1.4.3: owner-approved 2026-08-02 — BET_DOLLARS increased 10 → 100
      // for both BTC and ETH per-window sizing.
      "1.4.3": {
        ALERT_MIN: 70,
        ALERT_MAX: 82,
        TIME_ALERT_SECONDS: 180,
        LIMIT_PRICE_BUFFER_CENTS: 1,
        BET_DOLLARS: 100,
        PRICE_FLOOR_CENTS: 70,
        PRICE_CAP_CENTS: 95,
      },
      // 1.5.0: owner-approved 2026-08-03 — TIME_ALERT_SECONDS reduced 180 → 120
      // (entry window narrowed from last 3:00 to last 2:00 before close).
      "1.5.0": {
        ALERT_MIN: 70,
        ALERT_MAX: 82,
        TIME_ALERT_SECONDS: 120,
        LIMIT_PRICE_BUFFER_CENTS: 1,
        BET_DOLLARS: 100,
        PRICE_FLOOR_CENTS: 70,
        PRICE_CAP_CENTS: 95,
      },
      // 1.5.1: owner-approved 2026-08-03 — BET_DOLLARS increased 100 → 200
      // for both BTC and ETH per-window sizing.
      "1.5.1": {
        ALERT_MIN: 70,
        ALERT_MAX: 82,
        TIME_ALERT_SECONDS: 120,
        LIMIT_PRICE_BUFFER_CENTS: 1,
        BET_DOLLARS: 200,
        PRICE_FLOOR_CENTS: 70,
        PRICE_CAP_CENTS: 95,
      },
      // 1.5.2: owner-approved 2026-08-05 — BET_DOLLARS reduced 200 → 10
      // for both BTC and ETH per-window sizing.
      "1.5.2": {
        ALERT_MIN: 70,
        ALERT_MAX: 82,
        TIME_ALERT_SECONDS: 120,
        LIMIT_PRICE_BUFFER_CENTS: 1,
        BET_DOLLARS: 10,
        PRICE_FLOOR_CENTS: 70,
        PRICE_CAP_CENTS: 95,
      },
      // 1.5.3: owner-approved 2026-08-08 — entry zone and executable-price
      // guard narrowed to the 80–92¢ inclusive band for both outcome sides.
      "1.5.3": {
        ALERT_MIN: 80,
        ALERT_MAX: 92,
        TIME_ALERT_SECONDS: 120,
        LIMIT_PRICE_BUFFER_CENTS: 1,
        BET_DOLLARS: 10,
        PRICE_FLOOR_CENTS: 80,
        PRICE_CAP_CENTS: 92,
      },
      // 1.5.4: owner-approved 2026-08-08 — BET_DOLLARS increased 10 → 50
      // for both BTC and ETH per-window sizing.
      "1.5.4": {
        ALERT_MIN: 80,
        ALERT_MAX: 92,
        TIME_ALERT_SECONDS: 120,
        LIMIT_PRICE_BUFFER_CENTS: 1,
        BET_DOLLARS: 50,
        PRICE_FLOOR_CENTS: 80,
        PRICE_CAP_CENTS: 92,
      },
      // 1.5.5: owner-approved 2026-08-09 — a valid 80–92¢ trigger must
      // revalidate the fresh selected-side executable L2 price is also 80–92¢.
      // This is a decision-path rule; constants remain unchanged.
      "1.5.5": {
        ALERT_MIN: 80,
        ALERT_MAX: 92,
        TIME_ALERT_SECONDS: 120,
        LIMIT_PRICE_BUFFER_CENTS: 1,
        BET_DOLLARS: 50,
        PRICE_FLOOR_CENTS: 80,
        PRICE_CAP_CENTS: 92,
      },
      // 1.6.0: owner-approved asset-specific sizing. BTC uses a $400 cap;
      // ETH uses a $100 cap and only enters at 88–92¢. The global 80–92¢
      // hard guard remains unchanged.
      "1.6.0": {
        ALERT_MIN: 80,
        ALERT_MAX: 92,
        TIME_ALERT_SECONDS: 120,
        LIMIT_PRICE_BUFFER_CENTS: 1,
        BTC_BET_DOLLARS: 400,
        ETH_BET_DOLLARS: 100,
        ETH_ENTRY_FLOOR_CENTS: 88,
        ETH_ENTRY_CAP_CENTS: 92,
        PRICE_FLOOR_CENTS: 80,
        PRICE_CAP_CENTS: 92,
      },
      // 1.7.0: owner-approved BTC-only executable entry band narrowed to
      // 85–89¢. The shared 80–92¢ hard guard remains unchanged.
      "1.7.0": {
        ALERT_MIN: 80,
        ALERT_MAX: 92,
        TIME_ALERT_SECONDS: 120,
        LIMIT_PRICE_BUFFER_CENTS: 1,
        BTC_BET_DOLLARS: 400,
        BTC_ENTRY_FLOOR_CENTS: 85,
        BTC_ENTRY_CAP_CENTS: 89,
        ETH_BET_DOLLARS: 100,
        ETH_ENTRY_FLOOR_CENTS: 88,
        ETH_ENTRY_CAP_CENTS: 92,
        PRICE_FLOOR_CENTS: 80,
        PRICE_CAP_CENTS: 92,
      },
      // 1.8.0: owner-approved 2026-08-12 — BTC and ETH per-window
      // cash-outlay caps both reduced to $50.
      "1.8.0": {
        ALERT_MIN: 80,
        ALERT_MAX: 92,
        TIME_ALERT_SECONDS: 120,
        LIMIT_PRICE_BUFFER_CENTS: 1,
        BTC_BET_DOLLARS: 50,
        BTC_ENTRY_FLOOR_CENTS: 85,
        BTC_ENTRY_CAP_CENTS: 89,
        ETH_BET_DOLLARS: 50,
        ETH_ENTRY_FLOOR_CENTS: 88,
        ETH_ENTRY_CAP_CENTS: 92,
        PRICE_FLOOR_CENTS: 80,
        PRICE_CAP_CENTS: 92,
      },
      // 1.9.0: owner-approved — BTC and ETH conditional entry bands and the
      // shared executable guard are narrowed to 90–92¢.
      "1.9.0": {
        ALERT_MIN: 90,
        ALERT_MAX: 92,
        TIME_ALERT_SECONDS: 120,
        LIMIT_PRICE_BUFFER_CENTS: 1,
        BTC_BET_DOLLARS: 50,
        BTC_ENTRY_FLOOR_CENTS: 90,
        BTC_ENTRY_CAP_CENTS: 92,
        ETH_BET_DOLLARS: 50,
        ETH_ENTRY_FLOOR_CENTS: 90,
        ETH_ENTRY_CAP_CENTS: 92,
        PRICE_FLOOR_CENTS: 90,
        PRICE_CAP_CENTS: 92,
      },
      // 1.10.0: owner-approved 2026-08-12 — BTC and ETH per-window
      // cash-outlay caps both increased from $50 to $100.
      "1.10.0": {
        ALERT_MIN: 90,
        ALERT_MAX: 92,
        TIME_ALERT_SECONDS: 120,
        LIMIT_PRICE_BUFFER_CENTS: 1,
        BTC_BET_DOLLARS: 100,
        BTC_ENTRY_FLOOR_CENTS: 90,
        BTC_ENTRY_CAP_CENTS: 92,
        ETH_BET_DOLLARS: 100,
        ETH_ENTRY_FLOOR_CENTS: 90,
        ETH_ENTRY_CAP_CENTS: 92,
        PRICE_FLOOR_CENTS: 90,
        PRICE_CAP_CENTS: 92,
      },
      // 1.11.0: owner-approved 2026-08-13 — BTC and ETH entry bands widened
      // from 90–92¢ to 89–95¢ while retaining the $100 per-window caps.
      "1.11.0": {
        ALERT_MIN: 89,
        ALERT_MAX: 95,
        TIME_ALERT_SECONDS: 120,
        LIMIT_PRICE_BUFFER_CENTS: 1,
        BTC_BET_DOLLARS: 100,
        BTC_ENTRY_FLOOR_CENTS: 89,
        BTC_ENTRY_CAP_CENTS: 95,
        ETH_BET_DOLLARS: 100,
        ETH_ENTRY_FLOOR_CENTS: 89,
        ETH_ENTRY_CAP_CENTS: 95,
        PRICE_FLOOR_CENTS: 89,
        PRICE_CAP_CENTS: 95,
      },
      // 1.12.0: owner-approved 2026-08-13 — BTC and ETH entry bands restored
      // to 90–92¢ while retaining the $100 per-window caps.
      "1.12.0": {
        ALERT_MIN: 90,
        ALERT_MAX: 92,
        TIME_ALERT_SECONDS: 120,
        LIMIT_PRICE_BUFFER_CENTS: 1,
        BTC_BET_DOLLARS: 100,
        BTC_ENTRY_FLOOR_CENTS: 90,
        BTC_ENTRY_CAP_CENTS: 92,
        ETH_BET_DOLLARS: 100,
        ETH_ENTRY_FLOOR_CENTS: 90,
        ETH_ENTRY_CAP_CENTS: 92,
        PRICE_FLOOR_CENTS: 90,
        PRICE_CAP_CENTS: 92,
      },
      "1.13.0": {
        ALERT_MIN: 89,
        ALERT_MAX: 95,
        TIME_ALERT_SECONDS: 120,
        LIMIT_PRICE_BUFFER_CENTS: 1,
        BTC_BET_DOLLARS: 100,
        BTC_ENTRY_FLOOR_CENTS: 89,
        BTC_ENTRY_CAP_CENTS: 95,
        ETH_BET_DOLLARS: 100,
        ETH_ENTRY_FLOOR_CENTS: 89,
        ETH_ENTRY_CAP_CENTS: 95,
        PRICE_FLOOR_CENTS: 89,
        PRICE_CAP_CENTS: 95,
      },
      // 1.14.0: owner-approved 2026-08-13 — entry floor raised from 89¢ to
      // 90¢ while retaining the 95¢ ceiling and $100 per-window caps.
      "1.14.0": {
        ALERT_MIN: 90,
        ALERT_MAX: 95,
        TIME_ALERT_SECONDS: 120,
        LIMIT_PRICE_BUFFER_CENTS: 1,
        BTC_BET_DOLLARS: 100,
        BTC_ENTRY_FLOOR_CENTS: 90,
        BTC_ENTRY_CAP_CENTS: 95,
        ETH_BET_DOLLARS: 100,
        ETH_ENTRY_FLOOR_CENTS: 90,
        ETH_ENTRY_CAP_CENTS: 95,
        PRICE_FLOOR_CENTS: 90,
        PRICE_CAP_CENTS: 95,
      },
      // 1.15.0: owner-approved 2026-08-13 — BTC and ETH per-window
      // cash-outlay caps increased from $100 to $200.
      "1.15.0": {
        ALERT_MIN: 90,
        ALERT_MAX: 95,
        TIME_ALERT_SECONDS: 120,
        LIMIT_PRICE_BUFFER_CENTS: 1,
        BTC_BET_DOLLARS: 200,
        BTC_ENTRY_FLOOR_CENTS: 90,
        BTC_ENTRY_CAP_CENTS: 95,
        ETH_BET_DOLLARS: 200,
        ETH_ENTRY_FLOOR_CENTS: 90,
        ETH_ENTRY_CAP_CENTS: 95,
        PRICE_FLOOR_CENTS: 90,
        PRICE_CAP_CENTS: 95,
      },
      // 1.16.0: owner-approved 2026-08-13 — BTC and ETH per-window
      // cash-outlay caps increased from $200 to $350.
      "1.16.0": {
        ALERT_MIN: 90,
        ALERT_MAX: 95,
        TIME_ALERT_SECONDS: 120,
        LIMIT_PRICE_BUFFER_CENTS: 1,
        BTC_BET_DOLLARS: 350,
        BTC_ENTRY_FLOOR_CENTS: 90,
        BTC_ENTRY_CAP_CENTS: 95,
        ETH_BET_DOLLARS: 350,
        ETH_ENTRY_FLOOR_CENTS: 90,
        ETH_ENTRY_CAP_CENTS: 95,
        PRICE_FLOOR_CENTS: 90,
        PRICE_CAP_CENTS: 95,
      },
      // 1.17.0: owner-approved 2026-08-14 — BTC and ETH per-window
      // cash-outlay caps reduced from $350 to $50.
      "1.17.0": {
        ALERT_MIN: 90,
        ALERT_MAX: 95,
        TIME_ALERT_SECONDS: 120,
        LIMIT_PRICE_BUFFER_CENTS: 1,
        BTC_BET_DOLLARS: 50,
        BTC_ENTRY_FLOOR_CENTS: 90,
        BTC_ENTRY_CAP_CENTS: 95,
        ETH_BET_DOLLARS: 50,
        ETH_ENTRY_FLOOR_CENTS: 90,
        ETH_ENTRY_CAP_CENTS: 95,
        PRICE_FLOOR_CENTS: 90,
        PRICE_CAP_CENTS: 95,
      },
      // 1.18.0: owner-approved 2026-08-14 — BTC and ETH per-window
      // cash-outlay caps increased from $50 to $100.
      "1.18.0": {
        ALERT_MIN: 90,
        ALERT_MAX: 95,
        TIME_ALERT_SECONDS: 120,
        LIMIT_PRICE_BUFFER_CENTS: 1,
        BTC_BET_DOLLARS: 100,
        BTC_ENTRY_FLOOR_CENTS: 90,
        BTC_ENTRY_CAP_CENTS: 95,
        ETH_BET_DOLLARS: 100,
        ETH_ENTRY_FLOOR_CENTS: 90,
        ETH_ENTRY_CAP_CENTS: 95,
        PRICE_FLOOR_CENTS: 90,
        PRICE_CAP_CENTS: 95,
      },
      // 1.19.0: owner-approved 2026-08-16 — BTC and ETH per-window
      // cash-outlay caps reduced from $100 to $1.
      "1.19.0": {
        ALERT_MIN: 90,
        ALERT_MAX: 95,
        TIME_ALERT_SECONDS: 120,
        LIMIT_PRICE_BUFFER_CENTS: 1,
        BTC_BET_DOLLARS: 1,
        BTC_ENTRY_FLOOR_CENTS: 90,
        BTC_ENTRY_CAP_CENTS: 95,
        ETH_BET_DOLLARS: 1,
        ETH_ENTRY_FLOOR_CENTS: 90,
        ETH_ENTRY_CAP_CENTS: 95,
        PRICE_FLOOR_CENTS: 90,
        PRICE_CAP_CENTS: 95,
      },
    };

    const snapshot = VERSION_SNAPSHOTS[STRATEGY_VERSION];
    assert.ok(
      snapshot,
      `STRATEGY_VERSION "${STRATEGY_VERSION}" has no snapshot entry in ` +
        `strategyConstants.sync.test.ts — after bumping the version, add a ` +
        `new snapshot of STRATEGY_CONFIG for it (do not edit old entries)`,
    );
    assert.deepEqual(
      { ...STRATEGY_CONFIG },
      snapshot,
      `STRATEGY_CONFIG no longer matches the snapshot recorded for ` +
        `STRATEGY_VERSION "${STRATEGY_VERSION}". A strategy constant changed ` +
        `without a version bump — bump STRATEGY_VERSION in ` +
        `src/strategy/decide.ts and add a new snapshot entry here`,
    );
  });

  it("autoTrader.ts SERIES_CONFIG uses the canonical asset caps, never literals", () => {
    const src = SRC("lib/autoTrader.ts");
    const block = src.match(/SERIES_CONFIG\s*=\s*\{[\s\S]*?\}\s*as const/);
    assert.ok(block, "autoTrader.ts: SERIES_CONFIG block not found");
    assert.ok(
      !/betDollars:\s*\d/.test(block![0]),
      "SERIES_CONFIG must reference BET_DOLLARS from autoTraderGuards.ts, not a numeric literal",
    );
    assert.ok(
      /KXBTC15M:\s*\{\s*betDollars:\s*BTC_BET_DOLLARS\s*\}/.test(block![0]) &&
        /KXETH15M:\s*\{\s*betDollars:\s*ETH_BET_DOLLARS\s*\}/.test(block![0]),
      "SERIES_CONFIG must use BTC_BET_DOLLARS and ETH_BET_DOLLARS",
    );
  });
});
