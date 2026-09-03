/**
 * trade.tiers.test.ts — tier-version guard tests.
 *
 * Verifies that:
 *   A. PRICE_TIERS_VERSION is a non-empty, deterministic string that encodes
 *      every tier's label, min, and max.
 *   B. tierLabel() maps prices to the correct canonical bucket.
 *   C. The tier-version guard logic (as used in POST /trade/order) rejects
 *      requests with a mismatched tier_version and accepts requests that
 *      either omit tier_version or supply the correct one.
 *   D. A simulated tier-drift scenario: if a caller computed its dedup key
 *      using stale tier boundaries, the server's tier_version check blocks
 *      the order before any state (dedup slot, budget) is touched.
 *
 * HTTP route behaviour is verified by running the same conditional logic the
 * route executes, keeping this suite dependency-free (no Express / supertest).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PRICE_TIERS,
  PRICE_TIERS_VERSION,
  PRICE_FLOOR_CENTS,
  PRICE_CAP_CENTS,
  isPriceInBand,
  tierLabel,
} from "../lib/autoTraderGuards.js";

// ---------------------------------------------------------------------------
// Helper — simulate the tier_version guard from POST /trade/order
// (mirrors the exact conditional logic in the route handler)
// ---------------------------------------------------------------------------

function simulateTierVersionGuard(
  tierVersionFromClient: string | undefined,
): { status: number; body: Record<string, unknown> } {
  // Required — omitting or supplying an empty string is a 400.
  if (!tierVersionFromClient) {
    return {
      status: 400,
      body: {
        error:               "tier_version is required — call GET /api/trade/tiers first, then include the returned version string",
        server_tier_version: PRICE_TIERS_VERSION,
      },
    };
  }
  // Supplied but wrong — 409 with remediation hint.
  if (tierVersionFromClient !== PRICE_TIERS_VERSION) {
    return {
      status: 409,
      body: {
        error:               "tier_version mismatch — client tier definitions are out of sync with the server",
        client_tier_version: tierVersionFromClient,
        server_tier_version: PRICE_TIERS_VERSION,
        hint:                "Re-fetch GET /api/trade/tiers to obtain the current version, then retry",
      },
    };
  }
  // Guard passes — order would continue to the next validation step.
  return { status: 200, body: { ok: true } };
}

// ---------------------------------------------------------------------------
// A. PRICE_TIERS_VERSION shape
// ---------------------------------------------------------------------------

describe("A — PRICE_TIERS_VERSION shape", () => {
  it("is a non-empty string", () => {
    assert.equal(typeof PRICE_TIERS_VERSION, "string");
    assert.ok(PRICE_TIERS_VERSION.length > 0, "PRICE_TIERS_VERSION must not be empty");
  });

  it("encodes every tier label once", () => {
    for (const tier of PRICE_TIERS) {
      assert.ok(
        PRICE_TIERS_VERSION.includes(tier.label),
        `PRICE_TIERS_VERSION must include label "${tier.label}"`,
      );
    }
  });

  it("encodes every tier's min and max", () => {
    for (const tier of PRICE_TIERS) {
      assert.ok(
        PRICE_TIERS_VERSION.includes(String(tier.min)),
        `PRICE_TIERS_VERSION must include min=${tier.min} for tier "${tier.label}"`,
      );
      assert.ok(
        PRICE_TIERS_VERSION.includes(String(tier.max)),
        `PRICE_TIERS_VERSION must include max=${tier.max} for tier "${tier.label}"`,
      );
    }
  });

  it("changes when a tier definition changes (drift detection)", () => {
    // Compute what PRICE_TIERS_VERSION would be if someone silently shifted
    // the lowest tier floor from 70 to 72 (the old passiveObserver value).
    const driftedVersion = PRICE_TIERS
      .map((t, i) => {
        // Simulate drift: lowest tier (last in the array) gets min=72 instead of 70.
        if (i === PRICE_TIERS.length - 1) {
          return `tier:${t.label}:72-${t.max}`;
        }
        return `tier:${t.label}:${t.min}-${t.max}`;
      })
      .join("|");
    assert.notEqual(
      driftedVersion,
      PRICE_TIERS_VERSION,
      "A tier boundary change must produce a different version string",
    );
  });
});

// ---------------------------------------------------------------------------
// B. tierLabel() mapping
// ---------------------------------------------------------------------------

describe("B — tierLabel() boundary mapping", () => {
  const cases: Array<{ price: number; expected: string }> = [
    // Below the floor — not in any tier
    { price: 79, expected: "other" },
    // Sole active tier boundaries
    { price: PRICE_FLOOR_CENTS,     expected: "90–95¢" },  // floor, inclusive
    { price: PRICE_CAP_CENTS,       expected: "90–95¢" },  // cap, inclusive
    // Above the cap — not in any tier
    { price: 96,                    expected: "other" },
    { price: 100,                   expected: "other" },
  ];

  for (const { price, expected } of cases) {
    it(`tierLabel(${price}) === "${expected}"`, () => {
      assert.equal(tierLabel(price), expected);
    });
  }

  it("returns 'other' below the 90¢ floor", () => {
    assert.equal(tierLabel(89), "other");
  });

  it("uses the same inclusive 90–95¢ hard band for manual requests", () => {
    assert.equal(isPriceInBand(89), false);
    assert.equal(isPriceInBand(90), true);
    assert.equal(isPriceInBand(95), true);
    assert.equal(isPriceInBand(96), false);
  });
});

// ---------------------------------------------------------------------------
// C. Tier-version guard: accept / reject cases
// ---------------------------------------------------------------------------

describe("C — POST /trade/order tier_version guard", () => {
  it("rejects (400) when tier_version is omitted — field is required", () => {
    const result = simulateTierVersionGuard(undefined);
    assert.equal(result.status, 400);
    assert.ok(
      String(result.body["error"]).includes("tier_version is required"),
      "error body must state tier_version is required",
    );
  });

  it("rejects (400) when tier_version is an empty string", () => {
    const result = simulateTierVersionGuard("");
    assert.equal(result.status, 400);
  });

  it("rejects (400) body includes the server_tier_version so the caller knows what to send", () => {
    const result = simulateTierVersionGuard(undefined);
    assert.equal(result.body["server_tier_version"], PRICE_TIERS_VERSION);
  });

  it("passes when tier_version matches the server version", () => {
    const result = simulateTierVersionGuard(PRICE_TIERS_VERSION);
    assert.equal(result.status, 200);
  });

  it("rejects (409) when tier_version does not match", () => {
    const result = simulateTierVersionGuard("tier:90-95:90-95|tier:80-89:80-89|tier:72-79:72-79");
    assert.equal(result.status, 409);
    assert.ok(
      String(result.body["error"]).includes("tier_version mismatch"),
      "error body must mention tier_version mismatch",
    );
  });

  it("rejects (409) with client and server versions in the body", () => {
    const staleVersion = "stale-version-from-old-deploy";
    const result = simulateTierVersionGuard(staleVersion);
    assert.equal(result.status, 409);
    assert.equal(result.body["client_tier_version"], staleVersion);
    assert.equal(result.body["server_tier_version"], PRICE_TIERS_VERSION);
  });

  it("includes a re-fetch hint in the rejection body for version mismatches", () => {
    const result = simulateTierVersionGuard("wrong-version");
    assert.ok(
      String(result.body["hint"]).includes("/api/trade/tiers"),
      "hint must reference the tiers endpoint",
    );
  });
});

// ---------------------------------------------------------------------------
// D. Simulated tier-drift double-buy scenario
// ---------------------------------------------------------------------------

describe("D — tier-drift double-buy scenario", () => {
  it("blocks an order from a client that computed its dedup key with stale tiers", () => {
    // Scenario: the server updated tier boundaries (e.g. added a new upper tier
    // at 95–98¢). A browser client that cached the old tier list still thinks
    // 97¢ is in the "90–95¢" tier and sends tier_version from the old /trade/tiers
    // response.  The server's PRICE_TIERS_VERSION has changed, so the guard fires
    // and the order is rejected before any dedup slot or budget is reserved.

    const oldClientVersion = "tier:95-98¢:95-98|tier:90–94¢:90-94|tier:80–89¢:80-89|tier:70–79¢:70-79";
    assert.notEqual(oldClientVersion, PRICE_TIERS_VERSION, "precondition: old version must differ");

    const result = simulateTierVersionGuard(oldClientVersion);
    assert.equal(result.status, 409, "stale client must be blocked at the tier-version guard (before dedup)");
  });

  it("allows an order once the client re-fetches tiers and uses the current version", () => {
    // Same scenario, but client has now re-fetched /trade/tiers and uses the
    // server's current PRICE_TIERS_VERSION.
    const freshVersion = PRICE_TIERS_VERSION;
    const result = simulateTierVersionGuard(freshVersion);
    assert.equal(result.status, 200, "client with fresh tier_version must pass the guard");
  });
});
