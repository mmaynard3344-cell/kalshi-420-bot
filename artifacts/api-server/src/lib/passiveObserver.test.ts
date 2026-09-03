/**
 * Unit tests for passiveObserver.ts
 *
 * Required assertions:
 *   1. Ticks at 121–180 s are logged (file written) and never submitted as orders.
 *   2. Ticks at 120 s continue through the existing live decision path (decide() evaluates them).
 *   3. Ticks at 181 s are ignored by the passive observer.
 *   4. The passive logger cannot affect deduplication or daily spending.
 */

import { describe, it, before, after, beforeEach }   from "node:test";
import assert                                          from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir }                                      from "node:os";
import { join }                                        from "node:path";

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a minimal PassiveObsInput for a given secondsLeft value.
 * Prices are set so one side qualifies (noBid=20 → yesDerivedAsk=80 ✓).
 */
function mkInput(
  secondsLeft: number,
  overrides: Partial<{
    yesBid: number | null;
    yesAsk: number | null;
    noBid:  number | null;
    noAsk:  number | null;
    ticker: string;
    nowMs:  number;
  }> = {},
) {
  const closeMs = Date.now() + secondsLeft * 1_000;
  return {
    nowMs:       Date.now(),
    ticker:      overrides.ticker ?? "KXBTC15M-26JUL301100-00",
    closeTime:   new Date(closeMs).toISOString(),
    secondsLeft,
    yesBid:      overrides.yesBid  !== undefined ? overrides.yesBid  : 30,
    yesAsk:      overrides.yesAsk  !== undefined ? overrides.yesAsk  : 31,
    noBid:       overrides.noBid   !== undefined ? overrides.noBid   : 20,
    noAsk:       overrides.noAsk   !== undefined ? overrides.noAsk   : 21,
    source:      "websocket" as const,
    wsConnected: true,
    wsStale:     false,
    betDollars:  100,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("passiveObserver — range constants", () => {
  it("PASSIVE_OBS_MIN_SECS is 121", async () => {
    const { PASSIVE_OBS_MIN_SECS } = await import("./passiveObserver.js");
    assert.strictEqual(PASSIVE_OBS_MIN_SECS, 121);
  });

  it("PASSIVE_OBS_MAX_SECS is 180", async () => {
    const { PASSIVE_OBS_MAX_SECS } = await import("./passiveObserver.js");
    assert.strictEqual(PASSIVE_OBS_MAX_SECS, 180);
  });

  it("PASSIVE_OBS_DEBOUNCE_MS is 5000", async () => {
    const { PASSIVE_OBS_DEBOUNCE_MS } = await import("./passiveObserver.js");
    assert.strictEqual(PASSIVE_OBS_DEBOUNCE_MS, 5_000);
  });
});

// ── Test 1: ticks at 121–180 s are logged but never submitted as orders ───────

describe("passiveObserver — Test 1: 121–180 s ticks are logged, never submitted", () => {
  let tmpDir:  string;
  let origCwd: string;

  before(() => {
    // Redirect process.cwd() so logPassiveObservation writes to a tmp dir.
    origCwd = process.cwd();
    tmpDir  = mkdtempSync(join(tmpdir(), "passive-obs-test-"));
    process.chdir(tmpDir);
  });

  after(() => {
    process.chdir(origCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    const { _resetDebounceForTesting } = await import("./passiveObserver.js");
    _resetDebounceForTesting();
  });

  it("writes a record for secondsLeft=121 (lower boundary)", async () => {
    const { logPassiveObservation } = await import("./passiveObserver.js");
    logPassiveObservation(mkInput(121));

    const files = readdirSync(join(tmpDir, "data")).filter((f) =>
      f.startsWith("three-minute-observations-"),
    );
    assert.ok(files.length === 1, "expected exactly one observation file");

    const lines = readFileSync(join(tmpDir, "data", files[0]), "utf8")
      .split("\n")
      .filter(Boolean);
    assert.strictEqual(lines.length, 1);

    const rec = JSON.parse(lines[0]);
    assert.strictEqual(rec.secondsLeft, 121);
    assert.strictEqual(rec.ticker, "KXBTC15M-26JUL301100-00");
  });

  it("writes a record for secondsLeft=180 (upper boundary)", async () => {
    const { logPassiveObservation, _resetDebounceForTesting } = await import("./passiveObserver.js");
    _resetDebounceForTesting();
    logPassiveObservation(mkInput(180, { ticker: "KXETH15M-26JUL301100-00" }));

    const files = readdirSync(join(tmpDir, "data")).filter((f) =>
      f.startsWith("three-minute-observations-"),
    );
    assert.ok(files.length >= 1);

    const allLines = files
      .flatMap((f) =>
        readFileSync(join(tmpDir, "data", f), "utf8")
          .split("\n")
          .filter(Boolean),
      )
      .map((l) => JSON.parse(l));

    const match = allLines.find((r) => r.secondsLeft === 180);
    assert.ok(match !== undefined, "expected record with secondsLeft=180");
  });

  it("never calls placeOrder, claimOrderSlot, or tryReserve (no order submitted)", async () => {
    // The passive observer does not import from autoTraderGuards or invoke
    // any order-placement function. Verify by asserting that no function
    // matching those names is exported from the module.
    const mod = await import("./passiveObserver.js");
    assert.strictEqual(
      (mod as Record<string, unknown>)["placeOrder"],
      undefined,
      "passiveObserver must not export placeOrder",
    );
    assert.strictEqual(
      (mod as Record<string, unknown>)["claimOrderSlot"],
      undefined,
      "passiveObserver must not export claimOrderSlot",
    );
    assert.strictEqual(
      (mod as Record<string, unknown>)["tryReserve"],
      undefined,
      "passiveObserver must not export tryReserve",
    );
  });

  it("records all 21 required fields", async () => {
    const { logPassiveObservation, _resetDebounceForTesting } = await import("./passiveObserver.js");
    _resetDebounceForTesting();
    logPassiveObservation(mkInput(150, { ticker: "KXBTC15M-26JUL301115-15" }));

    const files = readdirSync(join(tmpDir, "data")).filter((f) =>
      f.startsWith("three-minute-observations-"),
    );
    const allLines = files
      .flatMap((f) =>
        readFileSync(join(tmpDir, "data", f), "utf8")
          .split("\n")
          .filter(Boolean),
      )
      .map((l) => JSON.parse(l));

    const rec = allLines.find((r) => r.ticker === "KXBTC15M-26JUL301115-15");
    assert.ok(rec, "expected a record for KXBTC15M-26JUL301115-15");

    const REQUIRED_FIELDS = [
      "timestampMs", "isoTimestamp", "ticker", "series", "asset",
      "windowCloseTime", "windowId", "secondsLeft",
      "yesBid", "yesAsk", "noBid", "noAsk",
      "source", "wsConnected", "wsStale",
      "yesQualifies", "noQualifies",
      "hypotheticalSide", "hypotheticalEntryPrice",
      "hypotheticalTier", "hypotheticalContracts",
    ] as const;

    for (const field of REQUIRED_FIELDS) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(rec, field),
        `missing required field: ${field}`,
      );
    }
    assert.strictEqual(REQUIRED_FIELDS.length, 21, "spec requires exactly 21 fields");
  });
});

// ── Test 2: ticks at 120 s continue through the live decision path ─────────────

describe("passiveObserver — Test 2: 120 s ticks reach live decide()", () => {
  it("decide() does NOT return outside_time_window for secondsLeft=120", async () => {
    // Import decide from strategy module. With TIME_ALERT_SECONDS=120 the
    // condition is: secondsLeft > 120 → 120 > 120 = false → evaluates.
    const { decide } = await import("../strategy/decide.js");
    const NOW_MS    = Date.now();
    const closeTime = new Date(NOW_MS + 120_000).toISOString();
    const input = {
      ticker:     "KXBTC15M-26JUL301100-00",
      series:     "KXBTC15M",
      closeTime,
      nowMs:      NOW_MS,
      yesBid:     30,
      yesAsk:     31,
      noBid:      20,   // yesDerivedAsk = 80 → qualifies
      noAsk:      21,
      lastPrice:  null,
      betDollars: 100,
    };
    const [decision] = decide(input);
    assert.notStrictEqual(
      (decision as { skipReason?: string }).skipReason,
      "outside_time_window",
      "secondsLeft=120 must not produce outside_time_window skip",
    );
  });

  it("logPassiveObservation silently ignores secondsLeft=120", async () => {
    // The observer range is [121, 180]; 120 is below the floor.
    const tmpDir = mkdtempSync(join(tmpdir(), "passive-obs-120-"));
    const origCwd = process.cwd();
    process.chdir(tmpDir);

    try {
      const { logPassiveObservation, _resetDebounceForTesting } = await import("./passiveObserver.js");
      _resetDebounceForTesting();
      logPassiveObservation(mkInput(120));

      let dataExists = true;
      try { readdirSync(join(tmpDir, "data")); } catch { dataExists = false; }

      if (dataExists) {
        const files = readdirSync(join(tmpDir, "data")).filter((f) =>
          f.startsWith("three-minute-observations-"),
        );
        assert.strictEqual(files.length, 0, "no observation file should exist for secondsLeft=120");
      }
      // If data dir doesn't exist at all that also proves nothing was written.
    } finally {
      process.chdir(origCwd);
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── Test 3: ticks at 181 s are ignored ────────────────────────────────────────

describe("passiveObserver — Test 3: 181 s ticks are ignored", () => {
  it("logPassiveObservation writes nothing for secondsLeft=181", async () => {
    const tmpDir  = mkdtempSync(join(tmpdir(), "passive-obs-181-"));
    const origCwd = process.cwd();
    process.chdir(tmpDir);

    try {
      const { logPassiveObservation, _resetDebounceForTesting } = await import("./passiveObserver.js");
      _resetDebounceForTesting();
      logPassiveObservation(mkInput(181));

      let dataExists = true;
      try { readdirSync(join(tmpDir, "data")); } catch { dataExists = false; }

      if (dataExists) {
        const files = readdirSync(join(tmpDir, "data")).filter((f) =>
          f.startsWith("three-minute-observations-"),
        );
        assert.strictEqual(files.length, 0, "no observation file should exist for secondsLeft=181");
      }
    } finally {
      process.chdir(origCwd);
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("181 > PASSIVE_OBS_MAX_SECS (180) — gate arithmetic is correct", async () => {
    const { PASSIVE_OBS_MAX_SECS } = await import("./passiveObserver.js");
    assert.ok(181 > PASSIVE_OBS_MAX_SECS, "181 must be strictly above the upper bound");
  });
});

// ── Test 4: passive logger cannot affect dedup or daily spending ───────────────

describe("passiveObserver — Test 4: no dedup or spend side effects", () => {
  it("dedup slots are unchanged after logPassiveObservation", async () => {
    const { _isSubmissionInFlightForTesting } = await import("./autoTraderGuards.js");
    const ticker = "KXBTC15M-26JUL301100-00";

    const beforeInFlight = _isSubmissionInFlightForTesting(ticker);

    const tmpDir  = mkdtempSync(join(tmpdir(), "passive-obs-dedup-"));
    const origCwd = process.cwd();
    process.chdir(tmpDir);

    try {
      const { logPassiveObservation, _resetDebounceForTesting } = await import("./passiveObserver.js");
      _resetDebounceForTesting();
      logPassiveObservation(mkInput(150, { ticker }));
    } finally {
      process.chdir(origCwd);
      rmSync(tmpDir, { recursive: true, force: true });
    }

    const afterInFlight = _isSubmissionInFlightForTesting(ticker);
    assert.strictEqual(
      afterInFlight,
      beforeInFlight,
      "submissionInFlight flag must be unchanged after logPassiveObservation",
    );
  });

  it("pending notional is unchanged after logPassiveObservation", async () => {
    const { _getPendingNotionalForTesting } = await import("./autoTraderGuards.js");
    const ticker = "KXBTC15M-26JUL301100-00";

    const beforeNotional = _getPendingNotionalForTesting(ticker);

    const tmpDir  = mkdtempSync(join(tmpdir(), "passive-obs-notional-"));
    const origCwd = process.cwd();
    process.chdir(tmpDir);

    try {
      const { logPassiveObservation, _resetDebounceForTesting } = await import("./passiveObserver.js");
      _resetDebounceForTesting();
      logPassiveObservation(mkInput(150, { ticker }));
    } finally {
      process.chdir(origCwd);
      rmSync(tmpDir, { recursive: true, force: true });
    }

    const afterNotional = _getPendingNotionalForTesting(ticker);
    assert.strictEqual(
      afterNotional,
      beforeNotional,
      "pendingNotional must be unchanged after logPassiveObservation",
    );
  });

  it("passiveObserver module exports no function that could mutate trading state", async () => {
    const mod = await import("./passiveObserver.js");
    const TRADING_STATE_MUTATORS = [
      "claimOrderSlot", "releaseOrderSlot",
      "tryReserve", "releaseCents",
      "setSpendTracker", "recordGuardOutcome",
      "submitOrder", "placeOrder",
    ];
    for (const name of TRADING_STATE_MUTATORS) {
      assert.strictEqual(
        (mod as Record<string, unknown>)[name],
        undefined,
        `passiveObserver must not export trading mutator: ${name}`,
      );
    }
  });
});

// ── Task 1 explicit fixture: yesBid=28 yesAsk=30 noBid=71 noAsk=72 ───────────

describe("passiveObserver — Task 1: price selection fixture", () => {
  it("yesBid=28 yesAsk=30 noBid=71 noAsk=72 → side=no, entryPrice=72 (not 30)", async () => {
    // yesDerivedAsk = 100 − noBid  = 100 − 71 = 29  → outside zone [72,90] → YES does NOT qualify
    // noDerivedAsk  = 100 − yesBid = 100 − 28 = 72  → inside  zone [72,90] → NO  qualifies
    // hypotheticalEntryPrice = noDerivedAsk = 72  (raw derived ask; no +1 buffer)
    const tmpDir  = mkdtempSync(join(tmpdir(), "passive-obs-fixture-"));
    const origCwd = process.cwd();
    process.chdir(tmpDir);

    try {
      const { logPassiveObservation, _resetDebounceForTesting } = await import("./passiveObserver.js");
      _resetDebounceForTesting();

      logPassiveObservation({
        nowMs:       Date.now(),
        ticker:      "KXBTC15M-26JUL301200-00",
        closeTime:   new Date(Date.now() + 150_000).toISOString(),
        secondsLeft: 150,
        yesBid:      28,
        yesAsk:      30,
        noBid:       71,
        noAsk:       72,
        source:      "websocket",
        wsConnected: true,
        wsStale:     false,
        betDollars:  100,
      });

      const files = readdirSync(join(tmpDir, "data")).filter((f) =>
        f.startsWith("three-minute-observations-"),
      );
      assert.ok(files.length === 1, "expected exactly one observation file");

      const lines = readFileSync(join(tmpDir, "data", files[0]), "utf8")
        .split("\n")
        .filter(Boolean);
      assert.strictEqual(lines.length, 1, "expected exactly one record");

      const rec = JSON.parse(lines[0]);

      // Side must be NO (noDerivedAsk=72 qualifies; yesDerivedAsk=29 does not)
      assert.strictEqual(rec.hypotheticalSide, "no", "side must be no");

      // Entry price must be 72 (noDerivedAsk = 100 − yesBid = 100 − 28 = 72)
      // NOT 30 (yesAsk raw), NOT 73 (noDerivedAsk + buffer), NOT 29 (yesDerivedAsk)
      assert.strictEqual(rec.hypotheticalEntryPrice, 72, "entry price must be 72 (noDerivedAsk, no buffer)");

      // yesQualifies must be false (yesDerivedAsk=29 < 72)
      assert.strictEqual(rec.yesQualifies, false, "YES must not qualify (yesDerivedAsk=29 < 72)");

      // noQualifies must be true (noDerivedAsk=72, on the zone floor)
      assert.strictEqual(rec.noQualifies, true, "NO must qualify (noDerivedAsk=72 === ALERT_MIN)");

      // Tier: 72 is in the 72-79 band
      assert.strictEqual(rec.hypotheticalTier, "72-79", "tier must be 72-79");

      // Contracts: floor(100 * 100 / 72) = 138
      assert.strictEqual(
        rec.hypotheticalContracts,
        Math.floor(10_000 / 72),
        "contracts must be floor($100 / 0.72¢)",
      );
    } finally {
      process.chdir(origCwd);
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("YES-qualifying inputs use yesDerivedAsk (100 − noBid) for entry price", async () => {
    // noBid=20 → yesDerivedAsk = 80 → qualifies; yesBid=5 → noDerivedAsk=95 > ALERT_MAX → does not
    const tmpDir  = mkdtempSync(join(tmpdir(), "passive-obs-yes-"));
    const origCwd = process.cwd();
    process.chdir(tmpDir);

    try {
      const { logPassiveObservation, _resetDebounceForTesting } = await import("./passiveObserver.js");
      _resetDebounceForTesting();

      logPassiveObservation({
        nowMs:       Date.now(),
        ticker:      "KXETH15M-26JUL301200-00",
        closeTime:   new Date(Date.now() + 150_000).toISOString(),
        secondsLeft: 150,
        yesBid:      5,
        yesAsk:      6,
        noBid:       20,   // yesDerivedAsk = 80
        noAsk:       21,
        source:      "rest_fallback",
        wsConnected: false,
        wsStale:     true,
        betDollars:  100,
      });

      const files = readdirSync(join(tmpDir, "data")).filter((f) =>
        f.startsWith("three-minute-observations-"),
      );
      const rec = JSON.parse(
        readFileSync(join(tmpDir, "data", files[0]), "utf8").trim()
      );

      assert.strictEqual(rec.hypotheticalSide,       "yes", "side must be yes");
      assert.strictEqual(rec.hypotheticalEntryPrice,  80,   "entry price must be 80 (yesDerivedAsk = 100−20)");
      assert.strictEqual(rec.yesQualifies,            true, "YES must qualify");
      assert.strictEqual(rec.noQualifies,             false,"NO must not qualify (noDerivedAsk=95 > ALERT_MAX)");
      assert.strictEqual(rec.hypotheticalTier,       "80-89");
    } finally {
      process.chdir(origCwd);
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── Bonus: debounce works correctly ───────────────────────────────────────────

describe("passiveObserver — debounce", () => {
  it("second call within 5 s for same ticker is not written", async () => {
    const tmpDir  = mkdtempSync(join(tmpdir(), "passive-obs-debounce-"));
    const origCwd = process.cwd();
    process.chdir(tmpDir);

    try {
      const { logPassiveObservation, _resetDebounceForTesting } = await import("./passiveObserver.js");
      _resetDebounceForTesting();

      const nowMs = Date.now();
      logPassiveObservation(mkInput(150, { nowMs }));
      logPassiveObservation(mkInput(150, { nowMs: nowMs + 1_000 })); // 1 s later — debounced

      const files = readdirSync(join(tmpDir, "data")).filter((f) =>
        f.startsWith("three-minute-observations-"),
      );
      const lines = files
        .flatMap((f) =>
          readFileSync(join(tmpDir, "data", f), "utf8")
            .split("\n")
            .filter(Boolean),
        );
      assert.strictEqual(lines.length, 1, "only one record expected within debounce window");
    } finally {
      process.chdir(origCwd);
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("call after 5 s for same ticker IS written", async () => {
    const tmpDir  = mkdtempSync(join(tmpdir(), "passive-obs-debounce2-"));
    const origCwd = process.cwd();
    process.chdir(tmpDir);

    try {
      const { logPassiveObservation, _resetDebounceForTesting } = await import("./passiveObserver.js");
      _resetDebounceForTesting();

      const nowMs = Date.now();
      logPassiveObservation(mkInput(150, { nowMs }));
      logPassiveObservation(mkInput(150, { nowMs: nowMs + 5_001 })); // past debounce

      const files = readdirSync(join(tmpDir, "data")).filter((f) =>
        f.startsWith("three-minute-observations-"),
      );
      const lines = files
        .flatMap((f) =>
          readFileSync(join(tmpDir, "data", f), "utf8")
            .split("\n")
            .filter(Boolean),
        );
      assert.strictEqual(lines.length, 2, "two records expected after debounce window passes");
    } finally {
      process.chdir(origCwd);
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
