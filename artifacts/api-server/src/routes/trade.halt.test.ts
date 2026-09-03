/**
 * trade.ts — environment kill switch tests.
 *
 * These tests exercise the exported primitives that implement env-var and
 * workspace-environment halt behaviour:
 *
 *   envTradingDisabled()         — live check of AUTO_TRADING_ENABLED / TRADING_ENABLED
 *   envWorkspaceHaltActive()     — live check of REPLIT_DEPLOYMENT !== "1"
 *   isEnvLocked()                — either of the above
 *   isTradingHalted()            — isEnvLocked() || runtime flag
 *   _setTradingHaltedForTesting  — sets the runtime flag in isolation
 *
 * HTTP route behaviour (409 body, status code) is covered by checking the same
 * conditional logic the route uses, keeping the suite dependency-free (no
 * Express / supertest needed).
 *
 * Covers:
 *   A. Startup — AUTO_TRADING_ENABLED=false → trading halted immediately
 *   B. Runtime clear blocked by env kill switch
 *   C. Runtime halt (halted:true) always succeeds
 *   D. No env var + REPLIT_DEPLOYMENT=1 → normal runtime halt / resume
 *   E. Workspace halt — no REPLIT_DEPLOYMENT → trading locked at startup
 *   F. Production environment — REPLIT_DEPLOYMENT=1 → not workspace-locked
 *   G. Workspace lock cannot be cleared by POST /trade/halt
 */

import assert from "node:assert/strict";
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import {
  envTradingDisabled,
  envWorkspaceHaltActive,
  isEnvLocked,
  isWorkspaceEnvironment,
  isProductionRuntime,
  isTradingHalted,
  getDogeOrderSubmissionStatus,
  _setTradingHaltedForTesting,
  workspaceTradingEnabled,
} from "../lib/tradingKillSwitch.js";

// ---------------------------------------------------------------------------
// Helpers — simulate POST /trade/halt route logic
// ---------------------------------------------------------------------------

/** Simulate the guard logic from POST /trade/halt for the "clear" path. */
function simulateClearHalt(): { status: number; body: Record<string, unknown> } {
  if (isEnvLocked()) {
    return {
      status: 409,
      body: {
        trading_halted:   true,
        environment_lock: true,
        error: "Trading cannot be enabled while an environment lock is active (AUTO_TRADING_ENABLED=false, TRADING_ENABLED=false, or workspace environment).",
      },
    };
  }
  _setTradingHaltedForTesting(false);
  return { status: 200, body: { trading_halted: isTradingHalted(), environment_lock: isEnvLocked() } };
}

/** Simulate the guard logic from POST /trade/halt for the "set halted" path. */
function simulateSetHalt(): { status: number; body: Record<string, unknown> } {
  // halted: true always succeeds regardless of env lock
  _setTradingHaltedForTesting(true);
  return { status: 200, body: { trading_halted: isTradingHalted(), environment_lock: isEnvLocked() } };
}

// ---------------------------------------------------------------------------
// A. Startup with AUTO_TRADING_ENABLED=false → trading is halted
// ---------------------------------------------------------------------------

describe("A — env kill switch: AUTO_TRADING_ENABLED=false", () => {
  before(() => {
    process.env["AUTO_TRADING_ENABLED"] = "false";
    delete process.env["TRADING_ENABLED"];
    _setTradingHaltedForTesting(false); // runtime flag is clear — env must still win
  });

  after(() => {
    delete process.env["AUTO_TRADING_ENABLED"];
    _setTradingHaltedForTesting(false);
  });

  it("envTradingDisabled() returns true", () => {
    assert.equal(envTradingDisabled(), true);
  });

  it("isTradingHalted() returns true even when runtime flag is false", () => {
    // runtime flag is explicitly false; env lock must override
    assert.equal(isTradingHalted(), true);
  });
});

describe("DOGE new-entry retirement", () => {
  const saved = {
    replDeployment: process.env["REPLIT_DEPLOYMENT"],
    autoTrading: process.env["AUTO_TRADING_ENABLED"],
    trading: process.env["TRADING_ENABLED"],
    dogeStrategy: process.env["DOGE_NO_MARTINGALE_ENABLED"],
    dogeException: process.env["DOGE_GLOBAL_HALT_EXCEPTION_ENABLED"],
  };

  beforeEach(() => {
    process.env["REPLIT_DEPLOYMENT"] = "1";
    process.env["AUTO_TRADING_ENABLED"] = "false";
    delete process.env["TRADING_ENABLED"];
    process.env["DOGE_NO_MARTINGALE_ENABLED"] = "true";
    process.env["DOGE_GLOBAL_HALT_EXCEPTION_ENABLED"] = "true";
    _setTradingHaltedForTesting(false);
  });

  after(() => {
    const restore = (name: string, value: string | undefined) => {
      if (value == null) delete process.env[name]; else process.env[name] = value;
    };
    restore("REPLIT_DEPLOYMENT", saved.replDeployment);
    restore("AUTO_TRADING_ENABLED", saved.autoTrading);
    restore("TRADING_ENABLED", saved.trading);
    restore("DOGE_NO_MARTINGALE_ENABLED", saved.dogeStrategy);
    restore("DOGE_GLOBAL_HALT_EXCEPTION_ENABLED", saved.dogeException);
    _setTradingHaltedForTesting(false);
  });

  it("never permits DOGE even when legacy exception settings are enabled", () => {
    const doge = getDogeOrderSubmissionStatus("KXDOGE15M-26AUG221200-00");
    assert.equal(isTradingHalted(), true, "the global halt continues to protect normal routes");
    assert.equal(doge.doge_order_submission_permitted, false);
    assert.equal(doge.doge_order_submission_reason, "doge_new_entries_retired");
    assert.equal(getDogeOrderSubmissionStatus("KXBTC15M-26AUG221200-00").doge_order_submission_permitted, false);
    assert.equal(getDogeOrderSubmissionStatus("KXETH15M-26AUG221200-00").doge_order_submission_permitted, false);
    assert.equal(getDogeOrderSubmissionStatus("KXSOL15M-26AUG221200-00").doge_order_submission_permitted, false);
  });

  it("ignores legacy DOGE flags", () => {
    delete process.env["DOGE_GLOBAL_HALT_EXCEPTION_ENABLED"];
    assert.equal(getDogeOrderSubmissionStatus("KXDOGE15M-26AUG221200-00").doge_order_submission_permitted, false);
    process.env["DOGE_GLOBAL_HALT_EXCEPTION_ENABLED"] = "true";
    delete process.env["DOGE_NO_MARTINGALE_ENABLED"];
    assert.equal(getDogeOrderSubmissionStatus("KXDOGE15M-26AUG221200-00").doge_order_submission_permitted, false);
  });

  it("remains retired in a workspace and during a runtime halt", () => {
    delete process.env["REPLIT_DEPLOYMENT"];
    assert.equal(
      getDogeOrderSubmissionStatus("KXDOGE15M-26AUG221200-00").doge_order_submission_reason,
      "doge_new_entries_retired",
    );
    process.env["REPLIT_DEPLOYMENT"] = "1";
    _setTradingHaltedForTesting(true);
    assert.equal(
      getDogeOrderSubmissionStatus("KXDOGE15M-26AUG221200-00").doge_order_submission_reason,
      "doge_new_entries_retired",
    );
  });
});

describe("A — env kill switch: TRADING_ENABLED=false (legacy alias)", () => {
  before(() => {
    delete process.env["AUTO_TRADING_ENABLED"];
    process.env["TRADING_ENABLED"] = "false";
    _setTradingHaltedForTesting(false);
  });

  after(() => {
    delete process.env["TRADING_ENABLED"];
    _setTradingHaltedForTesting(false);
  });

  it("envTradingDisabled() returns true via legacy alias", () => {
    assert.equal(envTradingDisabled(), true);
  });

  it("isTradingHalted() returns true via legacy alias", () => {
    assert.equal(isTradingHalted(), true);
  });
});

// ---------------------------------------------------------------------------
// B. POST {"halted":false} blocked while env kill switch is active
// ---------------------------------------------------------------------------

describe("B — env lock blocks runtime clear", () => {
  before(() => {
    process.env["AUTO_TRADING_ENABLED"] = "false";
    _setTradingHaltedForTesting(true);
  });

  after(() => {
    delete process.env["AUTO_TRADING_ENABLED"];
    _setTradingHaltedForTesting(false);
  });

  it("simulated clear returns HTTP 409", () => {
    const { status } = simulateClearHalt();
    assert.equal(status, 409);
  });

  it("response body has trading_halted: true", () => {
    const { body } = simulateClearHalt();
    assert.equal(body["trading_halted"], true);
  });

  it("response body has environment_lock: true", () => {
    const { body } = simulateClearHalt();
    assert.equal(body["environment_lock"], true);
  });

  it("runtime flag is unchanged after blocked clear", () => {
    _setTradingHaltedForTesting(true);
    simulateClearHalt(); // should be rejected
    // isTradingHalted() must still be true — env lock holds
    assert.equal(isTradingHalted(), true);
  });
});

// ---------------------------------------------------------------------------
// C. POST {"halted":true} always succeeds (even with env lock)
// ---------------------------------------------------------------------------

describe("C — halted:true always succeeds", () => {
  describe("with env lock active", () => {
    before(() => {
      process.env["AUTO_TRADING_ENABLED"] = "false";
      _setTradingHaltedForTesting(false);
    });

    after(() => {
      delete process.env["AUTO_TRADING_ENABLED"];
      _setTradingHaltedForTesting(false);
    });

    it("simulated set-halt returns HTTP 200", () => {
      const { status } = simulateSetHalt();
      assert.equal(status, 200);
    });

    it("isTradingHalted() is true after set-halt with env lock", () => {
      simulateSetHalt();
      assert.equal(isTradingHalted(), true);
    });
  });

  describe("without env lock (production env)", () => {
    before(() => {
      process.env["REPLIT_DEPLOYMENT"] = "1";
      delete process.env["AUTO_TRADING_ENABLED"];
      delete process.env["TRADING_ENABLED"];
      _setTradingHaltedForTesting(false);
    });

    after(() => {
      delete process.env["REPLIT_DEPLOYMENT"];
      _setTradingHaltedForTesting(false);
    });

    it("simulated set-halt returns HTTP 200", () => {
      const { status } = simulateSetHalt();
      assert.equal(status, 200);
    });

    it("isTradingHalted() is true after set-halt without env lock", () => {
      simulateSetHalt();
      assert.equal(isTradingHalted(), true);
    });
  });
});

// ---------------------------------------------------------------------------
// D. No env var + REPLIT_DEPLOYMENT=1 → normal runtime halt / resume
// ---------------------------------------------------------------------------

describe("D — no env var + production env: normal runtime halt / resume", () => {
  beforeEach(() => {
    process.env["REPLIT_DEPLOYMENT"] = "1";
    delete process.env["AUTO_TRADING_ENABLED"];
    delete process.env["TRADING_ENABLED"];
    _setTradingHaltedForTesting(false);
  });

  afterEach(() => {
    delete process.env["REPLIT_DEPLOYMENT"];
    delete process.env["AUTO_TRADING_ENABLED"];
  });

  it("envTradingDisabled() returns false when no kill-switch vars are set", () => {
    assert.equal(envTradingDisabled(), false);
  });

  it("isTradingHalted() follows the runtime flag when no env lock", () => {
    _setTradingHaltedForTesting(false);
    assert.equal(isTradingHalted(), false);

    _setTradingHaltedForTesting(true);
    assert.equal(isTradingHalted(), true);
  });

  it("runtime clear succeeds and returns HTTP 200 when no env lock", () => {
    _setTradingHaltedForTesting(true);
    const { status, body } = simulateClearHalt();
    assert.equal(status, 200);
    assert.equal(body["trading_halted"], false);
    assert.equal(body["environment_lock"], false);
  });

  it("trading_halted is false after a successful clear", () => {
    _setTradingHaltedForTesting(true);
    simulateClearHalt();
    assert.equal(isTradingHalted(), false);
  });

  it("setting AUTO_TRADING_ENABLED=false mid-process halts via isTradingHalted() immediately", () => {
    // Runtime flag is clear, no env var set → trading is enabled
    assert.equal(isTradingHalted(), false);
    // Operator sets the env var (e.g. via a platform secrets change + live reload)
    process.env["AUTO_TRADING_ENABLED"] = "false";
    // Next call to isTradingHalted() sees it immediately without a restart
    assert.equal(isTradingHalted(), true);
    // Cleanup handled by afterEach
  });
});

// ---------------------------------------------------------------------------
// E. Workspace halt — no REPLIT_DEPLOYMENT → trading locked at startup
// ---------------------------------------------------------------------------

describe("E — workspace halt: no REPLIT_DEPLOYMENT → trading locked", () => {
  before(() => {
    delete process.env["REPLIT_DEPLOYMENT"];
    delete process.env["AUTO_TRADING_ENABLED"];
    delete process.env["TRADING_ENABLED"];
    delete process.env["WORKSPACE_TRADING_ENABLED"];
    _setTradingHaltedForTesting(false); // runtime flag clear — workspace lock must still win
  });

  after(() => {
    _setTradingHaltedForTesting(false);
  });

  it("isWorkspaceEnvironment() returns true when REPLIT_DEPLOYMENT is absent", () => {
    assert.equal(isWorkspaceEnvironment(), true);
  });

  it("envWorkspaceHaltActive() returns true", () => {
    assert.equal(envWorkspaceHaltActive(), true);
  });

  it("isEnvLocked() returns true", () => {
    assert.equal(isEnvLocked(), true);
  });

  it("isTradingHalted() returns true even when runtime flag is false", () => {
    _setTradingHaltedForTesting(false);
    assert.equal(isTradingHalted(), true);
  });

  it("order submission is blocked (isTradingHalted === true) after a simulated restart", () => {
    // Simulate a restart: runtime flag resets to default (false)
    _setTradingHaltedForTesting(false);
    // Workspace lock ensures trading is still halted without any manual curl
    assert.equal(isTradingHalted(), true);
  });
});

// ---------------------------------------------------------------------------
// F. Workspace override cannot create a second runner
// ---------------------------------------------------------------------------

describe("F — workspace override remains fail-closed", () => {
  before(() => {
    delete process.env["REPLIT_DEPLOYMENT"];
    delete process.env["AUTO_TRADING_ENABLED"];
    delete process.env["TRADING_ENABLED"];
    process.env["WORKSPACE_TRADING_ENABLED"] = "true";
    _setTradingHaltedForTesting(false);
  });

  after(() => {
    delete process.env["WORKSPACE_TRADING_ENABLED"];
    _setTradingHaltedForTesting(false);
  });

  it("requires the exact true override value", () => {
    assert.equal(workspaceTradingEnabled(), true);
  });

  it("does not lift the environment lock while remaining in the workspace", () => {
    assert.equal(isWorkspaceEnvironment(), true);
    assert.equal(isProductionRuntime(), false);
    assert.equal(envWorkspaceHaltActive(), true);
    assert.equal(isEnvLocked(), true);
    assert.equal(isTradingHalted(), true);
  });
});

// ---------------------------------------------------------------------------
// G. Production environment — REPLIT_DEPLOYMENT=1 → not workspace-locked
// ---------------------------------------------------------------------------

describe("G — production environment: REPLIT_DEPLOYMENT=1 → not workspace-locked", () => {
  before(() => {
    process.env["REPLIT_DEPLOYMENT"] = "1";
    delete process.env["AUTO_TRADING_ENABLED"];
    delete process.env["TRADING_ENABLED"];
    _setTradingHaltedForTesting(false);
  });

  after(() => {
    delete process.env["REPLIT_DEPLOYMENT"];
    _setTradingHaltedForTesting(false);
  });

  it("isWorkspaceEnvironment() returns false when REPLIT_DEPLOYMENT=1", () => {
    assert.equal(isWorkspaceEnvironment(), false);
    assert.equal(isProductionRuntime(), true);
  });

  it("envWorkspaceHaltActive() returns false in production", () => {
    assert.equal(envWorkspaceHaltActive(), false);
  });

  it("isEnvLocked() returns false when no kill switches are active", () => {
    assert.equal(isEnvLocked(), false);
  });

  it("isTradingHalted() follows the runtime flag (trading can be enabled)", () => {
    _setTradingHaltedForTesting(false);
    assert.equal(isTradingHalted(), false);

    _setTradingHaltedForTesting(true);
    assert.equal(isTradingHalted(), true);
  });

  it("order submission is permitted when runtime flag is false", () => {
    _setTradingHaltedForTesting(false);
    assert.equal(isTradingHalted(), false);
  });
});

// ---------------------------------------------------------------------------
// H. Workspace lock cannot be cleared by POST /trade/halt {halted:false}
// ---------------------------------------------------------------------------

describe("H — workspace environment lock cannot be cleared by POST /trade/halt", () => {
  before(() => {
    delete process.env["REPLIT_DEPLOYMENT"];
    delete process.env["AUTO_TRADING_ENABLED"];
    delete process.env["TRADING_ENABLED"];
    delete process.env["WORKSPACE_TRADING_ENABLED"];
    _setTradingHaltedForTesting(false);
  });

  after(() => {
    _setTradingHaltedForTesting(false);
  });

  it("simulated clear returns HTTP 409", () => {
    const { status } = simulateClearHalt();
    assert.equal(status, 409);
  });

  it("response body has trading_halted: true", () => {
    const { body } = simulateClearHalt();
    assert.equal(body["trading_halted"], true);
  });

  it("response body has environment_lock: true", () => {
    const { body } = simulateClearHalt();
    assert.equal(body["environment_lock"], true);
  });

  it("isTradingHalted() remains true after blocked clear attempt", () => {
    _setTradingHaltedForTesting(false); // reset runtime flag — workspace lock must hold
    simulateClearHalt();
    assert.equal(isTradingHalted(), true);
  });

  it("halted:true still succeeds (panic button always works)", () => {
    const { status } = simulateSetHalt();
    assert.equal(status, 200);
    assert.equal(isTradingHalted(), true);
  });
});
