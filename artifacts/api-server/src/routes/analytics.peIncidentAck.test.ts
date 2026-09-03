/**
 * analytics.ts — protective-exit incident acknowledge auth + logic tests.
 *
 * These tests exercise the auth guard and acknowledge logic in isolation,
 * mirroring the no-Express / no-supertest pattern used by trade.halt.test.ts.
 *
 * Covers:
 *   A. Auth: missing token → 401
 *   B. Auth: wrong token → 401
 *   C. Auth: correct TRADE_API_TOKEN → passes through
 *   D. Auth: correct VITE_TRADE_API_TOKEN (dashboard token) → passes through
 *   E. Auth: no tokens configured → 503
 *   F. Acknowledge logic: valid id → updated flag returned
 *   G. Acknowledge logic: already-acknowledged id → updated: false (idempotent)
 *   H. Acknowledge logic: missing id rejected with 400
 */

import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { timingSafeEqual } from "node:crypto";

// ── Inline auth logic (mirrors analytics.ts requireAckAuth) ──────────────────

function makeRequireAckAuth(primaryToken: string, dashboardToken: string) {
  return function simulateRequireAckAuth(providedToken: string | undefined): { status: number; body: Record<string, unknown> } | "next" {
    if (!primaryToken && !dashboardToken) {
      return { status: 503, body: { error: "TRADE_API_TOKEN is not configured on the server" } };
    }
    if (!providedToken) {
      return { status: 401, body: { error: "Missing X-Trade-Token header" } };
    }
    const matches = (expected: string): boolean => {
      if (!expected) return false;
      const a = Buffer.from(providedToken, "utf8");
      const b = Buffer.from(expected, "utf8");
      return a.length === b.length && timingSafeEqual(a, b);
    };
    if (!matches(primaryToken) && !matches(dashboardToken)) {
      return { status: 401, body: { error: "Invalid X-Trade-Token header" } };
    }
    return "next";
  };
}

// ── Inline acknowledge handler logic ─────────────────────────────────────────

interface FakeIncident { id: string; acknowledgedAtMs: number | null }

function simulateAcknowledge(
  store: Map<string, FakeIncident>,
  id: unknown,
): { status: number; body: Record<string, unknown> } {
  // id validation (mirrors analytics.ts)
  if (!id || typeof id !== "string" || id.length > 200) {
    return { status: 400, body: { error: "invalid incident id" } };
  }
  const row = store.get(id);
  if (!row) {
    // Row not found — updated: false, but still 200 (no leak of existence)
    return { status: 200, body: { ok: true, updated: false } };
  }
  if (row.acknowledgedAtMs !== null) {
    // Already acknowledged — idempotent
    return { status: 200, body: { ok: true, updated: false } };
  }
  row.acknowledgedAtMs = Date.now();
  return { status: 200, body: { ok: true, updated: true } };
}

// ─────────────────────────────────────────────────────────────────────────────
// A — missing token → 401
// ─────────────────────────────────────────────────────────────────────────────

describe("A — acknowledge auth: missing X-Trade-Token header", () => {
  const auth = makeRequireAckAuth("secret-primary", "secret-dashboard");

  it("returns 401 when no token is provided", () => {
    const result = auth(undefined);
    assert.notEqual(result, "next");
    assert.equal((result as { status: number }).status, 401);
  });

  it("response body has error field", () => {
    const result = auth(undefined) as { status: number; body: Record<string, unknown> };
    assert.ok(typeof result.body["error"] === "string");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B — wrong token → 401
// ─────────────────────────────────────────────────────────────────────────────

describe("B — acknowledge auth: wrong X-Trade-Token header", () => {
  const auth = makeRequireAckAuth("secret-primary", "secret-dashboard");

  it("returns 401 for a completely wrong token", () => {
    const result = auth("wrong-token");
    assert.notEqual(result, "next");
    assert.equal((result as { status: number }).status, 401);
  });

  it("returns 401 for a token that is a prefix of the real one", () => {
    const result = auth("secret");
    assert.notEqual(result, "next");
    assert.equal((result as { status: number }).status, 401);
  });

  it("returns 401 for an empty string token", () => {
    const result = auth("");
    assert.notEqual(result, "next");
    assert.equal((result as { status: number }).status, 401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C — correct TRADE_API_TOKEN → passes auth
// ─────────────────────────────────────────────────────────────────────────────

describe("C — acknowledge auth: correct primary token", () => {
  const auth = makeRequireAckAuth("secret-primary", "secret-dashboard");

  it("returns 'next' for the correct primary token", () => {
    assert.equal(auth("secret-primary"), "next");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D — correct VITE_TRADE_API_TOKEN (dashboard token) → passes auth
// ─────────────────────────────────────────────────────────────────────────────

describe("D — acknowledge auth: correct dashboard token", () => {
  const auth = makeRequireAckAuth("secret-primary", "secret-dashboard");

  it("returns 'next' for the correct dashboard token", () => {
    assert.equal(auth("secret-dashboard"), "next");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E — no tokens configured → 503
// ─────────────────────────────────────────────────────────────────────────────

describe("E — acknowledge auth: no tokens configured on server", () => {
  const auth = makeRequireAckAuth("", "");

  it("returns 503 when neither token is configured", () => {
    const result = auth("any-token");
    assert.notEqual(result, "next");
    assert.equal((result as { status: number }).status, 503);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F — acknowledge logic: valid unacknowledged id → updated: true
// ─────────────────────────────────────────────────────────────────────────────

describe("F — acknowledge logic: unacknowledged incident", () => {
  let store: Map<string, FakeIncident>;
  before(() => {
    store = new Map([["inc-001", { id: "inc-001", acknowledgedAtMs: null }]]);
  });

  it("returns status 200", () => {
    assert.equal(simulateAcknowledge(store, "inc-001").status, 200);
  });

  it("returns ok: true and updated: true", () => {
    store.set("inc-002", { id: "inc-002", acknowledgedAtMs: null });
    const result = simulateAcknowledge(store, "inc-002");
    assert.equal(result.body["ok"], true);
    assert.equal(result.body["updated"], true);
  });

  it("sets acknowledgedAtMs to a positive number after acknowledge", () => {
    store.set("inc-003", { id: "inc-003", acknowledgedAtMs: null });
    simulateAcknowledge(store, "inc-003");
    const row = store.get("inc-003")!;
    assert.ok(row.acknowledgedAtMs !== null && row.acknowledgedAtMs > 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// G — acknowledge logic: already-acknowledged id → updated: false (idempotent)
// ─────────────────────────────────────────────────────────────────────────────

describe("G — acknowledge logic: already-acknowledged incident is idempotent", () => {
  let store: Map<string, FakeIncident>;
  const alreadyAckedMs = Date.now() - 60_000;

  before(() => {
    store = new Map([["inc-acked", { id: "inc-acked", acknowledgedAtMs: alreadyAckedMs }]]);
  });

  it("returns status 200 for already-acknowledged incident", () => {
    assert.equal(simulateAcknowledge(store, "inc-acked").status, 200);
  });

  it("returns updated: false for already-acknowledged incident", () => {
    assert.equal(simulateAcknowledge(store, "inc-acked").body["updated"], false);
  });

  it("does not overwrite the original acknowledgedAtMs timestamp", () => {
    simulateAcknowledge(store, "inc-acked");
    assert.equal(store.get("inc-acked")!.acknowledgedAtMs, alreadyAckedMs);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// H — acknowledge logic: bad id rejected with 400
// ─────────────────────────────────────────────────────────────────────────────

describe("H — acknowledge logic: invalid incident id is rejected", () => {
  const store = new Map<string, FakeIncident>();

  it("returns 400 for null id", () => {
    assert.equal(simulateAcknowledge(store, null).status, 400);
  });

  it("returns 400 for numeric id", () => {
    assert.equal(simulateAcknowledge(store, 42).status, 400);
  });

  it("returns 400 for an id over 200 characters", () => {
    const longId = "x".repeat(201);
    assert.equal(simulateAcknowledge(store, longId).status, 400);
  });

  it("returns 400 for empty string id", () => {
    assert.equal(simulateAcknowledge(store, "").status, 400);
  });
});
