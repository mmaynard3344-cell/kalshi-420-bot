/*
 * Service K — Kamakazee! SHADOW
 *
 * Observation only. This program cannot place Kalshi orders.
 *
 * Signal:
 *   - KXETH15M only
 *   - immediately preceding outcomes exactly YES, YES
 *   - prior 1-hour directional efficiency >= 0.85
 *   - hypothetical action: NO
 *
 * Shadow ladder:
 *   $100 -> $200 -> $400 after simulated losses
 *   win resets to $100
 *   $400 loss resets to $100
 *
 * IMPORTANT: shadow progression is informational only.
 */

const KALSHI_BASE = "https://api.elections.kalshi.com/trade-api/v2";
const SERIES = "KXETH15M";
const INTERVAL_MS = 15 * 60 * 1000;
const EFFICIENCY_THRESHOLD = 0.85;
const POLL_MS = 30_000;

let lastEvaluatedTicker = null;

function log(event, data = {}) {
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    service: "K",
    strategy: "Kamakazee!",
    mode: "SHADOW_ONLY",
    event,
    ...data,
  }));
}

async function fetchSettledMarkets() {
  const url = new URL(`${KALSHI_BASE}/markets`);
  url.searchParams.set("series_ticker", SERIES);
  url.searchParams.set("status", "settled");
  url.searchParams.set("limit", "20");

  const response = await fetch(url, {
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error(`Kalshi market-data HTTP ${response.status}`);
  }

  const body = await response.json();
  if (!Array.isArray(body.markets)) {
    throw new Error("Kalshi response missing markets array");
  }

  return body.markets;
}

function normalize(raw) {
  const ticker =
    typeof raw?.ticker === "string" ? raw.ticker : null;

  const openMs =
    typeof raw?.open_time === "string"
      ? Date.parse(raw.open_time)
      : NaN;

  const strike =
    typeof raw?.floor_strike === "number"
      ? raw.floor_strike
      : null;

  const result =
    typeof raw?.result === "string"
      ? raw.result.toUpperCase()
      : null;

  if (
    raw?.status !== "finalized" ||
    !ticker ||
    !ticker.startsWith("KXETH15M-") ||
    !Number.isFinite(openMs) ||
    openMs % INTERVAL_MS !== 0 ||
    !Number.isFinite(strike) ||
    strike <= 0 ||
    (result !== "YES" && result !== "NO")
  ) {
    return null;
  }

  return {
    ticker,
    openMs,
    strike,
    result,
  };
}

function contiguous(markets) {
  for (let i = 1; i < markets.length; i++) {
    if (markets[i].openMs - markets[i - 1].openMs !== INTERVAL_MS) {
      return false;
    }
  }
  return true;
}

function directionalEfficiency(points) {
  if (points.length !== 4) return null;

  const net = Math.abs(points[3].strike - points[0].strike);

  let path = 0;
  for (let i = 1; i < points.length; i++) {
    path += Math.abs(points[i].strike - points[i - 1].strike);
  }

  if (!(path > 0)) return null;
  return net / path;
}

async function evaluate() {
  let raw;

  try {
    raw = await fetchSettledMarkets();
  } catch (error) {
    log("FAIL_CLOSED", {
      reason: "market_data_unavailable",
      error: String(error?.message ?? error),
    });
    return;
  }

  const markets = raw
    .map(normalize)
    .filter(Boolean)
    .sort((a, b) => a.openMs - b.openMs);

  if (markets.length < 5) {
    log("FAIL_CLOSED", {
      reason: "insufficient_finalized_history",
      count: markets.length,
    });
    return;
  }

  const recent = markets.slice(-5);

  if (!contiguous(recent)) {
    log("FAIL_CLOSED", {
      reason: "non_adjacent_markets",
      tickers: recent.map((m) => m.ticker),
    });
    return;
  }

  const latest = recent[4];

  if (latest.ticker === lastEvaluatedTicker) {
    return;
  }

  lastEvaluatedTicker = latest.ticker;

  /*
   * The four markets ending immediately before the hypothetical
   * next-market decision form K's one-hour price path.
   */
  const hour = recent.slice(1, 5);
  const efficiency = directionalEfficiency(hour);

  if (efficiency === null) {
    log("FAIL_CLOSED", {
      reason: "directional_efficiency_unavailable",
      ticker: latest.ticker,
    });
    return;
  }

  const previousTwo = hour.slice(-2).map((m) => m.result);
  const yesYes =
    previousTwo[0] === "YES" &&
    previousTwo[1] === "YES";

  const qualifies =
    efficiency >= EFFICIENCY_THRESHOLD &&
    yesYes;

  log("EVALUATION", {
    latestFinalizedTicker: latest.ticker,
    previousTwo,
    directionalEfficiency: Number(efficiency.toFixed(6)),
    threshold: EFFICIENCY_THRESHOLD,
    qualifies,
    hypotheticalSide: qualifies ? "NO" : null,
    hypotheticalStartingPrincipalDollars: qualifies ? 100 : null,
    limitPriceCents: qualifies ? 50 : null,
  });

  if (qualifies) {
    log("SHADOW_SIGNAL", {
      message: "K WOULD BET NO $100 @ maximum 50c",
      executable: false,
    });
  }
}

log("STARTUP", {
  series: SERIES,
  executable: false,
  orderSubmissionCodePresent: false,
  directionalEfficiencyThreshold: EFFICIENCY_THRESHOLD,
  requiredPriorOutcomes: ["YES", "YES"],
  hypotheticalSide: "NO",
  hypotheticalLadderDollars: [100, 200, 400],
  pollMs: POLL_MS,
});

await evaluate();

setInterval(() => {
  evaluate().catch((error) => {
    log("FAIL_CLOSED", {
      reason: "unexpected_evaluation_error",
      error: String(error?.message ?? error),
    });
  });
}, POLL_MS);
