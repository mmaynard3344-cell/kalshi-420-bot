/**
 * Pure daily-budget logic — no I/O, no logging, no side effects.
 *
 * All functions accept an explicit `now: Date` so the caller (trade.ts) passes
 * `new Date()` in production and a fixed date in tests. This makes every
 * behaviour deterministic under test without needing to mock globals.
 *
 * Timezone: America/New_York (Eastern) — Kalshi's home timezone. All 15-minute
 * markets are defined in ET, and the $8,000 daily cap is intended to align with
 * a US trading day, not a UTC day.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DailyBudgetState {
  /** America/New_York calendar date, YYYY-MM-DD. */
  date: string;
  /** Notional reserved so far today, in cents. Released on order failure. */
  spentCents: number;
}

export interface RollResult {
  /** The state to use from now on (may be same object if no roll). */
  next: DailyBudgetState;
  /** True when the date advanced and spentCents was reset. */
  rolled: boolean;
  priorDate: string;
  priorSpentCents: number;
}

export interface ReserveResult {
  /** True when the reservation was accepted (cap not exceeded). */
  ok: boolean;
  /** State after the operation (updated even if ok=false for date rolls). */
  next: DailyBudgetState;
  /** Roll metadata — rolled=true when midnight passed between calls. */
  rollResult: RollResult;
}

// ── Date helper ───────────────────────────────────────────────────────────────

/**
 * Returns the current Eastern calendar date as YYYY-MM-DD.
 * Uses the IANA timezone database (always available in Node ≥ 12 on Replit).
 * DST transitions are handled automatically: America/New_York covers both
 * EST (UTC-5) and EDT (UTC-4).
 */
export function easternDay(now: Date): string {
  // en-CA locale always formats as YYYY-MM-DD, which is what we want.
  return now.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

// ── Pure state transitions ────────────────────────────────────────────────────

/**
 * If `now` is on a different Eastern date than `state.date`, returns a fresh
 * state with spentCents reset to 0. Otherwise returns the state unchanged.
 *
 * Called both on the sweep timer path (proactive) and inside tryReserve
 * (lazy — guarantees the cap is checked against the correct day's spend).
 */
export function rollIfNewDay(state: DailyBudgetState, now: Date): RollResult {
  const today = easternDay(now);
  if (state.date === today) {
    return {
      next:           state,
      rolled:         false,
      priorDate:      state.date,
      priorSpentCents: state.spentCents,
    };
  }
  return {
    next:           { date: today, spentCents: 0 },
    rolled:         true,
    priorDate:      state.date,
    priorSpentCents: state.spentCents,
  };
}

/**
 * Atomically: roll the date if needed, check the cap, and increment spend.
 *
 * "Atomic" here means synchronous — no await points between the date check,
 * the cap check, and the mutation. In Node.js's single-threaded event loop
 * this guarantees that two concurrent reservation attempts cannot both see
 * the same stale date or both pass the cap check.
 */
export function tryReserve(
  state:    DailyBudgetState,
  cents:    number,
  maxCents: number,
  now:      Date,
): ReserveResult {
  const rollResult = rollIfNewDay(state, now);
  const current    = rollResult.next;

  if (current.spentCents + cents > maxCents) {
    return { ok: false, next: current, rollResult };
  }
  return {
    ok:         true,
    next:       { ...current, spentCents: current.spentCents + cents },
    rollResult,
  };
}

/** Returns a new state with cents subtracted (floor 0). Non-mutating. */
export function releaseCents(state: DailyBudgetState, cents: number): DailyBudgetState {
  return { ...state, spentCents: Math.max(0, state.spentCents - cents) };
}

// ── Next reset timestamp ──────────────────────────────────────────────────────

/**
 * Returns the UTC instant of the next Eastern midnight after `now`.
 *
 * Strategy: ET is either UTC-4 (EDT, summer) or UTC-5 (EST, winter).
 * Midnight ET on a given calendar day is therefore either 04:00 or 05:00 UTC
 * the following day. We try 04:00 UTC first — if that instant is still on the
 * same ET calendar date as `now`, the offset must be -5 (EST), so we use
 * 05:00 UTC instead.
 *
 * This handles DST transitions correctly without importing a tz library.
 */
export function nextEasternMidnight(now: Date): Date {
  const today = easternDay(now);
  const [y, m, d] = today.split("-").map(Number) as [number, number, number];
  // Candidate at UTC-4 offset (EDT): midnight ET = next day 04:00 UTC
  const at04 = new Date(Date.UTC(y, m - 1, d + 1, 4, 0, 0, 0));
  // If this candidate is already past today in ET, it is midnight EDT — done.
  if (easternDay(at04) !== today) return at04;
  // Otherwise we're in EST (UTC-5): midnight ET = next day 05:00 UTC
  return new Date(Date.UTC(y, m - 1, d + 1, 5, 0, 0, 0));
}

// ── Persistence helpers ───────────────────────────────────────────────────────

/**
 * Parses a value read from the budget JSON file.
 *
 * Handles:
 *   • New format:   { "date": "YYYY-MM-DD", "spentCents": N }
 *   • Legacy format: { "day": "YYYY-MM-DD", "spentCents": N }
 *     (old code stored UTC dates under the key "day"; the field is migrated on
 *      first write. The date value itself may differ from Eastern by up to
 *      ~5 hours; the comparison against easternDay() handles this correctly —
 *      a UTC "2026-07-30" stored at 1 AM ET on July 29 will not match Eastern
 *      "2026-07-29", so spend is safely reset.)
 *   • Corrupted / missing → fresh state for today
 *
 * A server restart on the same Eastern calendar day restores the spend counter.
 * A restart on a new day resets it to 0.
 */
export function parseBudgetFile(raw: unknown, now: Date): DailyBudgetState {
  const today = easternDay(now);

  if (raw !== null && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;

    // Accept either new ("date") or legacy ("day") key
    const dateField =
      typeof obj["date"] === "string" ? obj["date"] :
      typeof obj["day"]  === "string" ? obj["day"]  :
      null;

    const spentCents = typeof obj["spentCents"] === "number" ? obj["spentCents"] : null;

    if (dateField !== null && spentCents !== null && spentCents >= 0) {
      return dateField === today
        ? { date: today, spentCents }   // same day — restore spend
        : { date: today, spentCents: 0 }; // new day — reset
    }
  }

  // Corrupted, missing, or unexpected shape → fresh state
  return { date: today, spentCents: 0 };
}
