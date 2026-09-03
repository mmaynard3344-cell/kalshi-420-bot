/**
 * Clock abstraction for testable, injectable time.
 *
 * Live code uses liveClock (wraps Date.now / new Date).
 * Tests and replay use fixedClock(ms) to pin time to a known instant.
 *
 * The clock is only injected into the pure decision layer (decide.ts).
 * Guards in simulator.ts use the per-tick nowMs passed by the runner,
 * not a shared clock instance — keeping each simulation step deterministic.
 */

export interface Clock {
  /** Current wall-clock time in milliseconds. */
  nowMs():   number;
  /** Current wall-clock time as a Date object. */
  nowDate(): Date;
}

/** Production clock — wraps the real wall clock. */
export const liveClock: Clock = {
  nowMs:   () => Date.now(),
  nowDate: () => new Date(),
};

/**
 * Fixed clock that always returns the same instant.
 * Use in unit tests and replay runs where time must be deterministic.
 */
export function fixedClock(ms: number): Clock {
  const d = new Date(ms);
  return {
    nowMs:   () => ms,
    nowDate: () => d,
  };
}
