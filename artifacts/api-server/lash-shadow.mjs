/*
 * Service L — Lash SHADOW ONLY
 * Observes public Kalshi ETH 15-minute markets and records hypothetical
 * 50-cent resting orders. This process has no authenticated API client and
 * contains no order-submission path.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import {
  contractsForStep,
  principalForStep,
  restingIntent,
  signalFromFinalized,
  transition,
} from "./lash-rules.mjs";

const PUBLIC_BASE = "https://api.elections.kalshi.com/trade-api/v2";
const SERIES = "KXETH15M";
const INTERVAL_MS = 15 * 60 * 1000;
const POLL_MS = 15_000;
let inFlight = false;

function log(event, data = {}) {
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    service: "L",
    strategy: "Lash",
    mode: "SHADOW",
    event,
    ...data,
  }));
}

async function publicFetch(path, params = {}) {
  const url = new URL(PUBLIC_BASE + path);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`Kalshi public market-data HTTP ${response.status}`);
  return response.json();
}

function normalizeMarket(raw) {
  const ticker = typeof raw?.ticker === "string" ? raw.ticker : null;
  const openMs = typeof raw?.open_time === "string" ? Date.parse(raw.open_time) : NaN;
  const closeMs = typeof raw?.close_time === "string" ? Date.parse(raw.close_time) : NaN;
  const result = typeof raw?.result === "string" ? raw.result.toUpperCase() : null;
  if (!ticker?.startsWith(`${SERIES}-`) || !Number.isFinite(openMs) || !Number.isFinite(closeMs)) return null;
  return { ...raw, ticker, openMs, closeMs, result };
}

function askCents(market, side) {
  const raw = side === "YES"
    ? market?.yes_ask_dollars ?? market?.yes_ask
    : market?.no_ask_dollars ?? market?.no_ask;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  return value <= 1 ? Math.round(value * 100) : Math.round(value);
}

async function init() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS lash_shadow_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      step INTEGER NOT NULL CHECK (step BETWEEN 0 AND 2),
      carried_side TEXT CHECK (carried_side IN ('YES','NO')),
      last_signal_ticker TEXT,
      updated_at_ms BIGINT NOT NULL
    )
  `);
  await db.execute(sql`
    INSERT INTO lash_shadow_state(singleton, step, updated_at_ms)
    VALUES (1, 0, ${Date.now()}) ON CONFLICT (singleton) DO NOTHING
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS lash_shadow_intents (
      target_ticker TEXT PRIMARY KEY,
      signal_ticker TEXT NOT NULL,
      side TEXT NOT NULL CHECK (side IN ('YES','NO')),
      step INTEGER NOT NULL CHECK (step BETWEEN 0 AND 2),
      principal_cents INTEGER NOT NULL,
      requested_contracts INTEGER NOT NULL,
      limit_cents INTEGER NOT NULL DEFAULT 50,
      observed_cross BOOLEAN NOT NULL DEFAULT FALSE,
      first_cross_at_ms BIGINT,
      best_observed_ask_cents INTEGER,
      official_result TEXT,
      transition_applied BOOLEAN NOT NULL DEFAULT FALSE,
      created_at_ms BIGINT NOT NULL,
      updated_at_ms BIGINT NOT NULL
    )
  `);
}

async function readState() {
  const result = await db.execute(sql`
    SELECT step, carried_side, last_signal_ticker
    FROM lash_shadow_state WHERE singleton = 1
  `);
  return result.rows[0];
}

async function reconcileOpenIntents() {
  const rows = await db.execute(sql`
    SELECT * FROM lash_shadow_intents
    WHERE transition_applied = FALSE
    ORDER BY created_at_ms ASC LIMIT 10
  `);
  for (const row of rows.rows) {
    const response = await publicFetch(`/markets/${encodeURIComponent(row.target_ticker)}`);
    const market = normalizeMarket(response.market ?? response);
    if (!market) throw new Error(`invalid public market payload for ${row.target_ticker}`);
    const observedAsk = askCents(market, row.side);
    const crossed = observedAsk != null && observedAsk <= Number(row.limit_cents);
    if (observedAsk != null) {
      await db.execute(sql`
        UPDATE lash_shadow_intents SET
          observed_cross = observed_cross OR ${crossed},
          first_cross_at_ms = CASE WHEN observed_cross OR NOT ${crossed}
            THEN first_cross_at_ms ELSE ${Date.now()} END,
          best_observed_ask_cents = CASE
            WHEN best_observed_ask_cents IS NULL THEN ${observedAsk}
            ELSE LEAST(best_observed_ask_cents, ${observedAsk}) END,
          updated_at_ms = ${Date.now()}
        WHERE target_ticker = ${row.target_ticker}
      `);
    }
    if (market.status !== "finalized" || (market.result !== "YES" && market.result !== "NO")) continue;
    const refreshed = await db.execute(sql`
      SELECT observed_cross FROM lash_shadow_intents WHERE target_ticker = ${row.target_ticker}
    `);
    const hypotheticalFilled = Boolean(refreshed.rows[0]?.observed_cross || crossed);
    const next = transition(
      { step: Number(row.step), side: row.side },
      { filledContracts: hypotheticalFilled ? Number(row.requested_contracts) : 0, officialResult: market.result },
    );
    const applied = await db.execute(sql`
      UPDATE lash_shadow_intents SET official_result = ${market.result},
        transition_applied = TRUE, updated_at_ms = ${Date.now()}
      WHERE target_ticker = ${row.target_ticker} AND transition_applied = FALSE
      RETURNING target_ticker
    `);
    if (applied.rows.length === 1) {
      await db.execute(sql`
        UPDATE lash_shadow_state SET step = ${next.step}, carried_side = ${next.side},
          updated_at_ms = ${Date.now()} WHERE singleton = 1
      `);
      log("SHADOW_SETTLED", {
        targetTicker: row.target_ticker,
        side: row.side,
        officialResult: market.result,
        observedCross: hypotheticalFilled,
        priorStep: Number(row.step),
        nextStep: next.step,
        transition: next.reason,
      });
    }
  }
}

async function exactNextMarket(latest) {
  const response = await publicFetch("/markets", { series_ticker: SERIES, status: "open", limit: 100 });
  const targetOpenMs = latest.openMs + INTERVAL_MS;
  const candidates = (response.markets ?? [])
    .map(normalizeMarket)
    .filter((market) => market && market.openMs === targetOpenMs);
  return candidates.length === 1 ? candidates[0] : null;
}

async function evaluate() {
  await reconcileOpenIntents();
  const pending = await db.execute(sql`
    SELECT COUNT(*)::int AS count FROM lash_shadow_intents WHERE transition_applied = FALSE
  `);
  if (Number(pending.rows[0]?.count ?? 0) > 0) return;

  const response = await publicFetch("/markets", { series_ticker: SERIES, status: "settled", limit: 10 });
  const markets = (response.markets ?? [])
    .map(normalizeMarket)
    .filter((market) => market?.status === "finalized" && (market.result === "YES" || market.result === "NO"))
    .sort((a, b) => a.openMs - b.openMs);
  if (markets.length < 2) return;
  const latest = markets.at(-1);
  const previous = markets.at(-2);
  if (latest.openMs - previous.openMs !== INTERVAL_MS) return;

  const current = await readState();
  let side = current?.carried_side ?? null;
  let signalTicker = current?.last_signal_ticker ?? null;
  if (!side) {
    const signal = signalFromFinalized([previous, latest]);
    log("EVALUATION", {
      latestFinalizedTicker: latest.ticker,
      previousTwo: [previous.result, latest.result],
      qualifies: Boolean(signal),
      side: signal?.side ?? null,
    });
    if (!signal || signal.signalTicker === current?.last_signal_ticker) return;
    side = signal.side;
    signalTicker = signal.signalTicker;
    await db.execute(sql`
      UPDATE lash_shadow_state SET carried_side = ${side}, last_signal_ticker = ${signalTicker},
        updated_at_ms = ${Date.now()} WHERE singleton = 1
    `);
  }

  const target = await exactNextMarket(latest);
  if (!target) {
    log("SHADOW_BLOCKED", { reason: "exact_next_market_unavailable", signalTicker });
    return;
  }
  const step = Number(current?.step ?? 0);
  const intent = restingIntent({ targetTicker: target.ticker, signalTicker, side, step });
  const reserved = await db.execute(sql`
    INSERT INTO lash_shadow_intents(
      target_ticker, signal_ticker, side, step, principal_cents,
      requested_contracts, limit_cents, created_at_ms, updated_at_ms
    ) VALUES(
      ${intent.targetTicker}, ${intent.signalTicker}, ${intent.side}, ${intent.step},
      ${intent.principalCents}, ${intent.contracts}, ${intent.limitPriceCents},
      ${Date.now()}, ${Date.now()}
    ) ON CONFLICT (target_ticker) DO NOTHING RETURNING target_ticker
  `);
  if (reserved.rows.length === 1) {
    log("SHADOW_RESTING_INTENT", {
      targetTicker: intent.targetTicker,
      signalTicker: intent.signalTicker,
      side: intent.side,
      step: intent.step,
      principalDollars: intent.principalCents / 100,
      contracts: intent.contracts,
      limitPriceCents: intent.limitPriceCents,
      timeInForce: "GTC",
      executable: false,
    });
  }
}

await init();
log("STARTUP", {
  executable: false,
  series: SERIES,
  ladderDollars: [0, 1, 2].map((step) => principalForStep(step) / 100),
  contractsAt50Cents: [0, 1, 2].map(contractsForStep),
  limitPriceCents: 50,
  timeInForce: "GTC",
  credentialsRequired: false,
  orderSubmissionPath: false,
});
await evaluate();
setInterval(() => {
  if (inFlight) return;
  inFlight = true;
  evaluate()
    .catch((error) => log("SHADOW_ERROR", { error: String(error?.message ?? error) }))
    .finally(() => { inFlight = false; });
}, POLL_MS);
