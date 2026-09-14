import { kalshiFetch } from "../kalshi.js";
import { logger } from "../logger.js";

const SERIES = "KXETH15M";
const INTERVAL_MS = 15 * 60_000;

export const G_REGIME_OFF_EFFICIENCY = 0.75;
export const G_REGIME_OFF_STREAK = 3;
export const G_REGIME_OFF_STREAK_EFFICIENCY = 0.55;
export const G_REGIME_ON_EFFICIENCY = 0.35;
export const G_REGIME_ON_REVERSAL_RATE = 0.50;

type OutcomeSide = "yes" | "no";
type GateState = "on" | "off";

export type GRegimeMetrics = {
  efficiency: number;
  reversalRate: number;
  currentStreak: number;
  currentStreakSide: OutcomeSide;
  netPct: number;
  pathPct: number;
};

export type GRegimeDecision = {
  allowEntries: boolean;
  state: GateState;
  action: "on" | "off" | "hold" | "fail_closed";
  reason: string;
  metrics: GRegimeMetrics | null;
};

let state: GateState = "off"; // Conservative restart default. ON requires positive proof.
let lastLoggedKey = "";

export function decideGRegimeGate(previous: GateState, metrics: GRegimeMetrics): {
  state: GateState; action: "on" | "off" | "hold"; reason: string;
} {
  if (metrics.efficiency >= G_REGIME_OFF_EFFICIENCY) {
    return { state: "off", action: previous === "off" ? "hold" : "off", reason: "high_directional_efficiency" };
  }
  if (metrics.currentStreak >= G_REGIME_OFF_STREAK && metrics.efficiency >= G_REGIME_OFF_STREAK_EFFICIENCY) {
    return { state: "off", action: previous === "off" ? "hold" : "off", reason: "persistent_streak_with_directionality" };
  }
  if (metrics.currentStreak < G_REGIME_OFF_STREAK
      && metrics.efficiency <= G_REGIME_ON_EFFICIENCY
      && metrics.reversalRate >= G_REGIME_ON_REVERSAL_RATE) {
    return { state: "on", action: previous === "on" ? "hold" : "on", reason: "choppy_reversal_regime" };
  }
  return { state: previous, action: "hold", reason: "hysteresis_band" };
}

function floorOf(market: Record<string, unknown> | undefined): number | null {
  if (!market) return null;
  const candidates = [market["floor_strike"], market["floor_strike_dollars"], market["strike"]];
  for (const value of candidates) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 500) return n;
  }
  return null;
}

function resultOf(market: Record<string, unknown>): OutcomeSide | null {
  const value = market["result"];
  return value === "yes" || value === "no" ? value : null;
}

export async function evaluateGRegimeGate(currentOpenMs: number, currentTicker: string): Promise<GRegimeDecision> {
  try {
    const [history, currentResponse] = await Promise.all([
      kalshiFetch<{ markets?: Array<Record<string, unknown>> }>("/markets", {
        series_ticker: SERIES,
        status: "settled",
        limit: 20,
      }),
      kalshiFetch<{ market?: Record<string, unknown> }>(`/markets/${encodeURIComponent(currentTicker)}`),
    ]);

    const byOpen = new Map<number, Record<string, unknown>>();
    for (const market of history.markets ?? []) {
      const open = typeof market["open_time"] === "string" ? Date.parse(market["open_time"] as string) : NaN;
      if (!Number.isFinite(open) || resultOf(market) == null || floorOf(market) == null) continue;
      byOpen.set(open, market);
    }

    // Four finalized outcomes and five adjacent floor strikes ending at the newly-opened market.
    const prior: Record<string, unknown>[] = [];
    for (let k = 4; k >= 1; k--) {
      const market = byOpen.get(currentOpenMs - k * INTERVAL_MS);
      if (!market) throw new Error(`missing settled market at -${k * 15}m`);
      prior.push(market);
    }
    const currentFloor = floorOf(currentResponse.market);
    if (currentFloor == null) throw new Error("current market floor unavailable");

    const floors = [...prior.map((market) => floorOf(market)!), currentFloor];
    const moves: number[] = [];
    for (let i = 1; i < floors.length; i++) moves.push((floors[i]! - floors[i - 1]!) / floors[i - 1]!);
    const path = moves.reduce((sum, value) => sum + Math.abs(value), 0);
    if (!(path > 0)) throw new Error("zero path in rolling hour");
    const net = (floors[floors.length - 1]! - floors[0]!) / floors[0]!;
    const efficiency = Math.min(1, Math.abs(net) / path);

    const outcomes = prior.map((market) => resultOf(market)!);
    let reversals = 0;
    for (let i = 1; i < outcomes.length; i++) if (outcomes[i] !== outcomes[i - 1]) reversals++;
    const reversalRate = reversals / (outcomes.length - 1);

    // Count the current finalized streak from the freshest market backward, beyond the one-hour window when available.
    const settled = [...byOpen.entries()].sort((a, b) => b[0] - a[0]);
    const expectedLatest = currentOpenMs - INTERVAL_MS;
    if (settled[0]?.[0] !== expectedLatest) throw new Error("latest settled market is stale");
    const currentStreakSide = resultOf(settled[0]![1])!;
    let currentStreak = 0;
    let expectedOpen = expectedLatest;
    for (const [open, market] of settled) {
      if (open !== expectedOpen || resultOf(market) !== currentStreakSide) break;
      currentStreak++;
      expectedOpen -= INTERVAL_MS;
    }

    const metrics: GRegimeMetrics = {
      efficiency,
      reversalRate,
      currentStreak,
      currentStreakSide,
      netPct: net * 100,
      pathPct: path * 100,
    };
    const decision = decideGRegimeGate(state, metrics);
    const priorState = state;
    state = decision.state;

    const logKey = `${currentTicker}|${state}|${decision.reason}`;
    if (decision.action !== "hold" || logKey !== lastLoggedKey) {
      logger.info({ service: "G", priorState, state, action: decision.action, reason: decision.reason, ...metrics },
        "G automatic regime gate evaluated");
      lastLoggedKey = logKey;
    }
    return { allowEntries: state === "on", state, action: decision.action, reason: decision.reason, metrics };
  } catch (err) {
    const logKey = `${currentTicker}|fail_closed|${String(err)}`;
    if (logKey !== lastLoggedKey) {
      logger.warn({ service: "G", err, currentTicker }, "G automatic regime gate data unavailable; entries fail closed");
      lastLoggedKey = logKey;
    }
    return { allowEntries: false, state, action: "fail_closed", reason: "data_unavailable", metrics: null };
  }
}

export function currentGRegimeGateState(): GateState { return state; }
