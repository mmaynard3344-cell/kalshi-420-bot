import { EventEmitter } from "events";
import WebSocket from "ws";
import { kalshiAuthHeaders } from "./kalshiAuth";
import { kalshiSeriesFetch, normalizeMarket } from "./kalshi";
import { logger } from "./logger";

/** Dedicated Kalshi Trade API production WebSocket host. */
export const KALSHI_WS_URL = "wss://external-api-ws.kalshi.com/trade-api/ws/v2";
/** Live market discovery and subscriptions are deliberately ETH-only. */
const SERIES            = ["KXETH15M"];
// 120 s avoids systematic coincidence with the 45 s reconcile timer (LCM = 360 s
// vs 180 s for 60 s), and the WS ping already keeps the connection alive between
// refresh cycles. Window rollovers are also caught by the autoTrader reconcile.
export const TICKER_REFRESH_MS = 120_000;
const RECONNECT_DELAY_MS = 3_000;
const PING_INTERVAL_MS  = 30_000; // keep idle connections alive
// Stagger series requests in refreshTickers to avoid simultaneous Kalshi hits
const SERIES_STAGGER_MS = 3_000;

export type KalshiMarketLifecycleEvent = {
  ticker: string;
  eventType: "created" | "activated";
  openTime: string;
  closeTime: string | null;
  exchangeIndex: number | null;
  floorStrike: number | null;
};

export function buildKalshiSubscriptionPayloads(activeTickers: string[], firstId: number) {
  return [
    {
      id: firstId,
      cmd: "subscribe",
      params: { channels: ["ticker", "trade"], market_tickers: activeTickers },
    },
    {
      id: firstId + 1,
      cmd: "subscribe",
      params: { channels: ["market_lifecycle_v2"] },
    },
  ] as const;
}

/** Reject malformed/non-ETH lifecycle events before they enter any consumer path. */
export function parseEthMarketLifecycle(
  raw: Record<string, unknown>,
): KalshiMarketLifecycleEvent | null {
  const ticker = raw["market_ticker"];
  const eventType = raw["event_type"];
  const openTs = raw["open_ts"];
  if (typeof ticker !== "string" || !ticker.startsWith("KXETH15M-")
    || (eventType !== "created" && eventType !== "activated")
    || typeof openTs !== "number" || !Number.isFinite(openTs)) return null;
  const metadata = raw["additional_metadata"];
  const meta = metadata != null && typeof metadata === "object"
    ? metadata as Record<string, unknown> : {};
  const closeTs = raw["close_ts"];
  return {
    ticker,
    eventType,
    openTime: new Date(openTs * 1_000).toISOString(),
    closeTime: typeof closeTs === "number" && Number.isFinite(closeTs)
      ? new Date(closeTs * 1_000).toISOString() : null,
    exchangeIndex: typeof raw["exchange_index"] === "number" && Number.isInteger(raw["exchange_index"])
      ? raw["exchange_index"] : null,
    floorStrike: typeof meta["floor_strike"] === "number" ? meta["floor_strike"] : null,
  };
}

class KalshiStream extends EventEmitter {
  private ws: WebSocket | null = null;

  private activeTickers: string[] = [];

  private msgId = 1;

  private reconnecting = false;

  private destroyed = false;

  private pingTimer: ReturnType<typeof setInterval> | null = null;

  /** Wall-clock ms when the most recent refreshTickers() call started. 0 = never. */
  private _lastRefreshAtMs = 0;

  /**
   * Latest normalized REST snapshot per ticker, refreshed every TICKER_REFRESH_MS.
   * WS ticker payloads omit fields like last_price, previous_price and
   * floor_strike; these are backfilled from the snapshot before emitting so
   * the dashboard card can display them. Display-only — no trading logic reads
   * the merged fields.
   */
  private restSnapshots = new Map<string, Record<string, unknown>>();

  /**
   * Last trade price (cents) emitted per ticker. Used to coalesce trade
   * bursts — only price *changes* are forwarded to SSE clients. Old window
   * tickers are pruned when the active tickers change.
   */
  private lastEmittedTradeCents = new Map<string, number>();

  /** Fields backfilled from the REST snapshot when missing from a WS tick. */
  private static readonly SNAPSHOT_FILL_FIELDS = [
    "last_price",
    "previous_price",
    "floor_strike",
    "rules_primary",
    "rules_secondary",
    "title",
    "subtitle",
    "event_ticker",
    "exchange_index",
    "close_time",
    "open_time",
    "expiration_time",
  ] as const;

  /** Returns the wall-clock timestamp (ms) when the last ticker refresh started.
   *  Used by the autoTrader reconcile timer to avoid firing within the refresh guard window. */
  get lastRefreshAtMs(): number { return this._lastRefreshAtMs; }

  /** Call once after the server is ready. */
  async start() {
    await this.refreshTickers();
    this.connect();
    setInterval(() => this.refreshTickers(), TICKER_REFRESH_MS);
  }

  /** Immediately re-fetch active tickers and reconnect if they changed.
   *  Fire-and-forget — call without await from rollover handlers. */
  async refreshTickers() {
    this._lastRefreshAtMs = Date.now();
    try {
      const tickers: string[] = [];
      for (let i = 0; i < SERIES.length; i++) {
        // Stagger per-series requests to avoid concurrent hits to Kalshi
        if (i > 0) await new Promise<void>((r) => setTimeout(r, SERIES_STAGGER_MS));
        // Use shared kalshiSeriesFetch so this request coalesces with autoTrader
        // REST fallback calls — preventing duplicate Kalshi hits at boundaries.
        const raw = await kalshiSeriesFetch(SERIES[i]);
        const t   = raw?.["ticker"] as string | undefined;
        if (t) {
          tickers.push(t);
          // Cache the normalized REST snapshot so WS ticks (which omit
          // last_price / previous_price / floor_strike) can be backfilled.
          this.restSnapshots.set(t, normalizeMarket(raw as Record<string, unknown>));
        }
        // Kalshi exposes the next 15-minute market before it opens. This is
        // discovery-only: consumers schedule a fresh post-open lookup and may
        // not evaluate or submit from this pre-open snapshot.
        const upcoming = await kalshiSeriesFetch(SERIES[i], { status: "unopened" });
        if (upcoming?.["ticker"] && upcoming?.["open_time"]) {
          this.emit("upcoming_market", normalizeMarket(upcoming));
        }
      }

      if (!tickers.length) return;

      const prev = [...this.activeTickers].sort().join(",");
      const next = [...tickers].sort().join(",");
      if (prev !== next) {
        logger.info({ tickers }, "KalshiStream: tickers changed, reconnecting");
        this.activeTickers = tickers;
        // Prune dedupe entries for tickers no longer active (old windows)
        for (const t of this.lastEmittedTradeCents.keys()) {
          if (!tickers.includes(t)) this.lastEmittedTradeCents.delete(t);
        }
        this.ws?.close(); // close triggers reconnect → re-subscribe
      }
    } catch (err) {
      logger.warn({ err }, "KalshiStream: ticker refresh failed");
    }
  }

  private connect() {
    if (this.destroyed || !this.activeTickers.length) return;

    try {
      const authHeaders = kalshiAuthHeaders("GET", "/trade-api/ws/v2");
      this.ws = new WebSocket(KALSHI_WS_URL, { headers: authHeaders });

      this.ws.on("open", () => {
        logger.info({ tickers: this.activeTickers }, "KalshiStream: WS open");
        this.reconnecting = false;
        this.subscribe();
        this.pingTimer = setInterval(() => {
          if (this.ws?.readyState === WebSocket.OPEN) this.ws.ping();
        }, PING_INTERVAL_MS);
      });

      this.ws.on("message", (raw: Buffer) => {
        try {
          const msg = JSON.parse(raw.toString()) as {
            type: string;
            msg?: Record<string, unknown>;
          };

          // Heartbeat: track any message so isWsStale() can distinguish
          // "dead connection" from "connected but no tickers yet".
          this._lastAnyMsgMs = Date.now();

          // Log every message at debug level — invaluable in production when
          // diagnosing "WS open but no ticks" reports.
          logger.debug(
            { type: msg.type, fields: msg.msg ? Object.keys(msg.msg) : [] },
            "KalshiStream: WS message received",
          );

          if (msg.type === "market_lifecycle_v2" && msg.msg) {
            const lifecycle = parseEthMarketLifecycle(msg.msg);
            if (lifecycle) this.emit("market_lifecycle", lifecycle);
          } else if (msg.type === "ticker" && msg.msg) {
            // ── Adapt WS payload to the shape normalizeMarket expects ──────────
            //
            // Kalshi WS v2 diverges from the REST response in two ways:
            //
            //  1. Field name: WS sends "market_ticker" (not "ticker").
            //     normalizeMarket reads m.ticker, so without remapping the
            //     ticker field is undefined and every tick is silently dropped.
            //
            //  2. Price format: WS sends prices as cent-integers (e.g. 45 for
            //     45 ¢).  normalizeMarket applies dollarsToCents() which
            //     multiplies by 100, yielding 4500 instead of 45.  Dividing
            //     by 100 first converts cent-integers back to dollar-decimals
            //     so the existing ×100 path produces the correct cent value.
            //     Values already ≤ 1.0 (dollar-decimal format) are left as-is.
            const inner = msg.msg as Record<string, unknown>;
            const adapted: Record<string, unknown> = { ...inner };

            // (1) market_ticker → ticker
            if (adapted["market_ticker"] !== undefined && adapted["ticker"] === undefined) {
              adapted["ticker"] = adapted["market_ticker"];
            }

            // (2) cent-integer prices → dollar-decimals
            for (const field of ["yes_bid", "yes_ask", "no_bid", "no_ask", "last_price", "previous_price"] as const) {
              const v = adapted[field];
              if (typeof v === "number" && v > 1) {
                adapted[field] = v / 100;
              }
            }

            const normalized = normalizeMarket(adapted);

            if (!normalized["ticker"]) {
              logger.warn(
                { msgKeys: Object.keys(inner) },
                "KalshiStream: ticker message missing ticker field — dropping (unexpected WS format)",
              );
              return;
            }

            // Backfill display fields the WS ticker channel omits from the
            // most recent REST snapshot (last_price, previous_price,
            // floor_strike, title, …). Dashes remain only when Kalshi has
            // never reported the field.
            const snapshot = this.restSnapshots.get(normalized["ticker"] as string);
            if (snapshot) {
              for (const field of KalshiStream.SNAPSHOT_FILL_FIELDS) {
                if (normalized[field] == null && snapshot[field] != null) {
                  normalized[field] = snapshot[field];
                }
              }
            }

            this.emit("ticker", normalized);
          } else if (msg.type === "trade" && msg.msg) {
            // ── Real-time last-trade price (display-only) ─────────────────────
            // The REST snapshot refreshes every TICKER_REFRESH_MS (120 s), so
            // between refreshes the Last value on the dashboard would lag by up
            // to 2 minutes. The WS "trade" channel carries each executed trade;
            // we use its yes_price to keep the cached snapshot's last_price
            // fresh and emit a lightweight event the SSE route forwards to the
            // dashboard. No trading logic listens to this event.
            const inner = msg.msg as Record<string, unknown>;
            const ticker = (inner["market_ticker"] ?? inner["ticker"]) as string | undefined;
            // Verified live 2026-08-02: the trade channel sends
            // yes_price_dollars as a STRING of dollar-decimals (e.g. "0.2400")
            // — not a numeric yes_price like older docs suggest. Accept both.
            let lastCents: number | null = null;
            const dollarStr = inner["yes_price_dollars"];
            const centNum   = inner["yes_price"];
            if (typeof dollarStr === "string" && dollarStr !== "" && Number.isFinite(Number(dollarStr))) {
              lastCents = Math.round(Number(dollarStr) * 100);
            } else if (typeof centNum === "number" && Number.isFinite(centNum)) {
              // cent-integer (e.g. 45 = 45¢); non-integer ≤1 values are dollars
              lastCents = Number.isInteger(centNum) && centNum >= 1
                ? centNum
                : Math.round(centNum * 100);
            }
            if (ticker && lastCents != null) {

              // Keep the snapshot cache current so subsequent WS ticker
              // backfills use the fresh last price instead of the stale one.
              const snapshot = this.restSnapshots.get(ticker);
              if (snapshot) snapshot["last_price"] = lastCents;

              // Coalesce bursts: live probing (2026-08-02) measured ~40
              // trades/s average with 143/s peaks on KXBTC15M+KXETH15M, and
              // ~70% of trades repeat the previous price. Each forwarded
              // event becomes an SSE write per client plus a React state
              // update, so only emit when the price actually changes.
              // Display-only — no trading logic listens to this event.
              if (this.lastEmittedTradeCents.get(ticker) !== lastCents) {
                this.lastEmittedTradeCents.set(ticker, lastCents);
                this.emit("trade", { ticker, last_price: lastCents });
              }
            }
          }
        } catch (err) {
          logger.warn({ err }, "KalshiStream: WS message parse error");
        }
      });

      this.ws.on("close", (code, reason) => {
        logger.info({ code, reason: reason.toString() }, "KalshiStream: WS closed");
        if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
        this.scheduleReconnect();
      });

      this.ws.on("error", (err) => {
        logger.warn({ err }, "KalshiStream: WS error");
        this.ws?.terminate();
      });
    } catch (err) {
      logger.warn({ err }, "KalshiStream: connect error");
      this.scheduleReconnect();
    }
  }

  private subscribe() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const [payload, lifecyclePayload] = buildKalshiSubscriptionPayloads(this.activeTickers, this.msgId);
    this.msgId += 2;
    this.ws.send(JSON.stringify(payload));
    logger.info(payload, "KalshiStream: subscribed");
    // Lifecycle is intentionally a separate unfiltered subscription: applying
    // active market_tickers here would hide the next ETH market's `created`
    // event. Consumers reject every non-ETH lifecycle message immediately.
    this.ws.send(JSON.stringify(lifecyclePayload));
    logger.info(lifecyclePayload, "KalshiStream: lifecycle subscribed");
  }

  private scheduleReconnect() {
    if (this.reconnecting || this.destroyed) return;
    this.reconnecting = true;
    setTimeout(() => { this.reconnecting = false; this.connect(); }, RECONNECT_DELAY_MS);
  }

  isConnected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Data-plane-only recovery for a detected final-window coverage gap.
   *
   * Bounded and safe by construction: it only refreshes REST snapshots and
   * re-establishes the WS subscription. It never places orders, never touches
   * trading guards, and never mutates any trading decision state. Rate limiting
   * lives in marketDataCoverage.runCoverageCheck (min spacing + per-window cap).
   *
   * Returns a short outcome string recorded on the diagnostic incident.
   */
  async recoverMarketData(reason: string): Promise<string> {
    logger.warn({ reason, tickers: this.activeTickers }, "KalshiStream: coverage recovery requested");
    // Refresh the REST snapshot + active ticker list first (also backfills
    // display fields and reconnects if the ticker set changed).
    try { await this.refreshTickers(); } catch { /* logged inside */ }

    if (this.ws?.readyState === WebSocket.OPEN) {
      // Connection is open but not delivering data — re-send the subscribe.
      this.subscribe();
      return "resubscribed_on_open_connection";
    }
    // Connection is not open — terminate any half-dead socket and let the
    // existing reconnect path (with its normal delay) re-establish it.
    try { this.ws?.terminate(); } catch { /* ignore */ }
    this.scheduleReconnect();
    return "reconnect_initiated";
  }

  /** Wall-clock ms of the last message received of ANY type (heartbeat proxy). */
  private _lastAnyMsgMs = 0;

  /**
   * Wall-clock ms of the most recent WS message of ANY type (subscription
   * confirmations, heartbeats, tickers, etc.).  Returns 0 if no message has
   * arrived since startup.  Use to distinguish a truly dead connection from
   * a live one that just hasn't delivered a ticker yet.
   */
  lastAnyMsgMs(): number {
    return this._lastAnyMsgMs;
  }
}

export const kalshiStream = new KalshiStream();
