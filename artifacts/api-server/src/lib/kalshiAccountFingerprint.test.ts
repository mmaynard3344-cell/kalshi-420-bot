/**
 * kalshiAccountFingerprint.test.ts
 *
 * Verifies the account-history fingerprint helper under four observable states:
 *   A. Happy path: fills present → stable fingerprint derived from oldest fill
 *   B. No fills: account has no history → status "no_fills", null fingerprint
 *   C. Auth failure: Kalshi rejects the request → status "unavailable", null fingerprint
 *   D. Multi-page: pagination stops at last cursor-free page; oldest fill wins
 */

import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import {
  getAccountHistoryFingerprint,
  _setAccountFingerprintFetchForTesting,
} from "./kalshiAccountFingerprint.js";
import { createHash } from "crypto";

afterEach(() => {
  _setAccountFingerprintFetchForTesting(null);
});

// ---------------------------------------------------------------------------
// A — happy path: oldest fill produces a deterministic fingerprint
// ---------------------------------------------------------------------------

describe("A — single-page fill history produces deterministic fingerprint", () => {
  it("returns status ok and a 16-char hex fingerprint", async () => {
    const fills = [
      { fill_id: "fill-aaa", created_time: "2025-01-01T00:00:00Z", market_ticker: "KXBTC15M-25JAN01T0000-100" },
      { fill_id: "fill-bbb", created_time: "2025-01-02T00:00:00Z", market_ticker: "KXBTC15M-25JAN02T0000-100" },
    ];
    _setAccountFingerprintFetchForTesting(async () => ({ fills, cursor: undefined } as unknown as never));

    const result = await getAccountHistoryFingerprint();

    assert.equal(result.status, "ok");
    assert.ok(result.fingerprint, "fingerprint must be set");
    assert.equal(result.fingerprint!.length, 16, "fingerprint must be 16 hex chars");
    assert.match(result.fingerprint!, /^[0-9a-f]{16}$/, "fingerprint must be lowercase hex");
  });

  it("fingerprint is derived from the OLDEST fill (earliest created_time)", async () => {
    const oldFill = { fill_id: "fill-old", created_time: "2024-06-01T00:00:00Z", market_ticker: "KXBTC15M-X" };
    const newFill = { fill_id: "fill-new", created_time: "2025-01-01T00:00:00Z", market_ticker: "KXBTC15M-Y" };

    // The API returns newest-first; old fill is on a "later" page that we still
    // process because we paginate exhaustively.
    _setAccountFingerprintFetchForTesting(async () => ({
      fills: [newFill, oldFill],
      cursor: undefined,
    } as unknown as never));

    const result = await getAccountHistoryFingerprint();

    assert.equal(result.status, "ok");
    // Recompute expected fingerprint independently from the oldest fill fields
    const expected = createHash("sha256")
      .update([oldFill.fill_id, oldFill.created_time, oldFill.market_ticker].join("|"))
      .digest("hex")
      .slice(0, 16);
    assert.equal(result.fingerprint, expected);
  });

  it("same fills always produce the same fingerprint (deterministic)", async () => {
    const fills = [
      { fill_id: "fill-xyz", created_time: "2024-12-31T23:59:59Z", market_ticker: "KXETH15M-Z" },
    ];
    _setAccountFingerprintFetchForTesting(async () => ({ fills, cursor: undefined } as unknown as never));

    const r1 = await getAccountHistoryFingerprint();

    // Clear the cache so a second real call would re-fetch, but verify first
    // that the fingerprint matches the independently-computed expected value.
    const expected = createHash("sha256")
      .update([fills[0].fill_id, fills[0].created_time, fills[0].market_ticker].join("|"))
      .digest("hex")
      .slice(0, 16);
    assert.equal(r1.fingerprint, expected);
  });
});

// ---------------------------------------------------------------------------
// B — no fills: account has no history
// ---------------------------------------------------------------------------

describe("B — account with no fills returns no_fills status", () => {
  it("returns status no_fills and null fingerprint", async () => {
    _setAccountFingerprintFetchForTesting(async () => ({ fills: [], cursor: undefined } as unknown as never));

    const result = await getAccountHistoryFingerprint();

    assert.equal(result.status, "no_fills");
    assert.equal(result.fingerprint, null);
  });

  it("skips fills that are missing fill_id or created_time", async () => {
    const fills = [
      { fill_id: "", created_time: "2025-01-01T00:00:00Z", market_ticker: "KXBTC15M-A" },
      { fill_id: "fill-ok", created_time: "", market_ticker: "KXBTC15M-B" },
    ];
    _setAccountFingerprintFetchForTesting(async () => ({ fills, cursor: undefined } as unknown as never));

    const result = await getAccountHistoryFingerprint();

    // Both fills are missing a required field — treated as no usable fills
    assert.equal(result.status, "no_fills");
    assert.equal(result.fingerprint, null);
  });
});

// ---------------------------------------------------------------------------
// C — auth failure: Kalshi rejects the request
// ---------------------------------------------------------------------------

describe("C — auth/network failure returns unavailable status", () => {
  it("returns status unavailable and null fingerprint on 401", async () => {
    _setAccountFingerprintFetchForTesting(async () => {
      throw Object.assign(new Error("Unauthorized"), { status: 401 });
    });

    const result = await getAccountHistoryFingerprint();

    assert.equal(result.status, "unavailable");
    assert.equal(result.fingerprint, null);
    assert.ok(
      "auth_error" in result && typeof (result as { auth_error: unknown }).auth_error === "string",
      "auth_error must be a string",
    );
  });

  it("returns status unavailable on network error", async () => {
    _setAccountFingerprintFetchForTesting(async () => {
      throw new Error("ECONNREFUSED");
    });

    const result = await getAccountHistoryFingerprint();

    assert.equal(result.status, "unavailable");
    assert.equal(result.fingerprint, null);
  });
});

// ---------------------------------------------------------------------------
// D — pagination: exhausts pages; oldest fill across all pages wins
// ---------------------------------------------------------------------------

describe("D — multi-page fill history uses oldest fill across all pages", () => {
  it("paginates until no cursor and picks the overall oldest fill", async () => {
    const page1Fills = [
      { fill_id: "fill-p1-new", created_time: "2025-03-01T00:00:00Z", market_ticker: "KXBTC15M-P1" },
    ];
    const page2Fills = [
      // Older fill on second page
      { fill_id: "fill-p2-old", created_time: "2024-01-15T00:00:00Z", market_ticker: "KXBTC15M-P2" },
    ];

    let callCount = 0;
    _setAccountFingerprintFetchForTesting(async <T>(_method: string, path: string): Promise<T> => {
      callCount++;
      if (callCount === 1) {
        // First page — return cursor to signal more pages
        return { fills: page1Fills, cursor: "cursor-abc" } as unknown as T;
      }
      // Second page — no cursor, pagination ends
      return { fills: page2Fills, cursor: undefined } as unknown as T;
    });

    const result = await getAccountHistoryFingerprint();

    assert.equal(result.status, "ok");
    assert.equal(callCount, 2, "must paginate through both pages");

    // Fingerprint must be from the older fill on page 2
    const expected = createHash("sha256")
      .update([page2Fills[0].fill_id, page2Fills[0].created_time, page2Fills[0].market_ticker].join("|"))
      .digest("hex")
      .slice(0, 16);
    assert.equal(result.fingerprint, expected);
  });

  it("stops paginating when MAX_FILLS cap is reached", async () => {
    // Simulate an account with a perpetual cursor — pagination must not loop forever.
    let calls = 0;
    _setAccountFingerprintFetchForTesting(async <T>(): Promise<T> => {
      calls++;
      // Generate 100 fills per page, always returning a cursor
      const fills = Array.from({ length: 100 }, (_, i) => ({
        fill_id: `fill-${calls}-${i}`,
        created_time: `2025-01-${String(calls).padStart(2, "0")}T00:00:00Z`,
        market_ticker: "KXBTC15M-X",
      }));
      return { fills, cursor: "always-more" } as unknown as T;
    });

    const result = await getAccountHistoryFingerprint();

    // Should eventually get a result (or unavailable), never loop indefinitely
    assert.ok(result.status === "ok" || result.status === "no_fills", "must not throw");
    // 50_000 fill cap / 100 per page = 500 max pages
    assert.ok(calls <= 500, `should cap pagination (called ${calls} times)`);
  });
});
