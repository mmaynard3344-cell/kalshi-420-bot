import { createHash, createSign } from "crypto";
import { logger } from "./logger.js";

export const KALSHI_TRADE_BASE = "https://external-api.kalshi.com/trade-api/v2";

export interface KalshiReadNetworkEvent {
  endpointCategory: string;
  errorClass: string | null;
  elapsedMs: number;
  retryCount: number;
  recoveryOutcome: "recovered" | "failed";
}

let readNetworkEventSink: ((event: KalshiReadNetworkEvent) => void) | null = null;
/** Wired by the API runtime to durable telemetry; no credentials or responses are included. */
export function setKalshiReadNetworkEventSink(sink: ((event: KalshiReadNetworkEvent) => void) | null): void {
  readNetworkEventSink = sink;
}

const GET_RETRY_DELAYS_MS = [200, 500, 1_500];
const AUTHENTICATED_READ_CONCURRENCY = 2;
const MAX_QUEUED_NON_SAFETY_READS = 100;
export type KalshiAuthenticatedReadPriority = "normal" | "safety";

type QueuedAuthenticatedRead<T> = {
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
};

/**
 * Kalshi applies account-wide authenticated-read limits. Keep a small shared
 * budget here so independently scheduled reconciliation/protective/dashboard
 * reads cannot become a retry storm. POSTs never use this scheduler.
 */
function createAuthenticatedReadScheduler(maxConcurrent = AUTHENTICATED_READ_CONCURRENCY) {
  let active = 0;
  let activeNormal = 0;
  let blockedUntil = 0;
  const safetyQueue: QueuedAuthenticatedRead<unknown>[] = [];
  const normalQueue: QueuedAuthenticatedRead<unknown>[] = [];

  const drain = () => {
    if (active >= maxConcurrent || (safetyQueue.length === 0 && normalQueue.length === 0)) return;
    const waitMs = Math.max(0, blockedUntil - Date.now());
    if (waitMs > 0) {
      setTimeout(drain, waitMs).unref?.();
      return;
    }
    while (active < maxConcurrent && Date.now() >= blockedUntil) {
      // Reserve one of the two account-wide slots for a safety verification.
      // Normal dashboard/reconciliation reads are bounded to one active slot,
      // while a live protective position check gets the next available slot.
      const isSafety = safetyQueue.length > 0;
      if (!isSafety && (normalQueue.length === 0 || activeNormal >= maxConcurrent - 1)) break;
      const next = (isSafety ? safetyQueue.shift() : normalQueue.shift())!;
      active++;
      if (!isSafety) activeNormal++;
      void next.run().then(next.resolve, next.reject).finally(() => {
        active--;
        if (!isSafety) activeNormal--;
        drain();
      });
    }
  };

  return {
    run<T>(operation: () => Promise<T>, priority: KalshiAuthenticatedReadPriority): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        if (priority === "normal" && normalQueue.length >= MAX_QUEUED_NON_SAFETY_READS) {
          reject(Object.assign(new Error("Kalshi authenticated read queue is full"), { code: "KALSHI_READ_QUEUE_FULL" }));
          return;
        }
        (priority === "safety" ? safetyQueue : normalQueue)
          .push({ run: operation, resolve, reject } as QueuedAuthenticatedRead<unknown>);
        drain();
      });
    },
    coolDown(delayMs: number): void {
      // A rate limit applies to the account, not the individual caller. Honor
      // the server's complete Retry-After interval rather than retrying early.
      blockedUntil = Math.max(blockedUntil, Date.now() + Math.max(0, delayMs));
      drain();
    },
    resetForTesting(): void {
      active = 0;
      activeNormal = 0;
      blockedUntil = 0;
      safetyQueue.splice(0, safetyQueue.length);
      normalQueue.splice(0, normalQueue.length);
    },
  };
}

const authenticatedReadScheduler = createAuthenticatedReadScheduler();

/** ETH markets roll every 15 minutes; warm the shared authenticated fetch path 5 s beforehand. */
export const KALSHI_HTTP_PREWARM_LEAD_MS = 5_000;
export const KALSHI_ETH_WINDOW_MS = 15 * 60_000;
let prewarmTimer: ReturnType<typeof setTimeout> | null = null;
let prewarmRequestForTesting: (() => Promise<unknown>) | null = null;

/** Return the next xx:14:55 / :29:55 / :44:55 / :59:55 UTC timestamp. */
export function nextKalshiAuthPrewarmAtMs(nowMs: number = Date.now()): number {
  let nextBoundaryMs = (Math.floor(nowMs / KALSHI_ETH_WINDOW_MS) + 1) * KALSHI_ETH_WINDOW_MS;
  if (nextBoundaryMs - KALSHI_HTTP_PREWARM_LEAD_MS < nowMs) {
    nextBoundaryMs += KALSHI_ETH_WINDOW_MS;
  }
  return nextBoundaryMs - KALSHI_HTTP_PREWARM_LEAD_MS;
}

/**
 * Read-only connection warm-up. This deliberately uses kalshiAuthFetch, the same
 * signed global-fetch transport as live orders, but normal priority so it can
 * never consume the scheduler slot reserved for order-safety reads.
 */
export function prewarmKalshiAuthTransport(): void {
  const request = prewarmRequestForTesting ?? (() => kalshiAuthFetch<Record<string, unknown>>(
    "GET",
    "/portfolio/balance",
    undefined,
    { readPriority: "normal" },
  ));
  void request().catch((err) => {
    logger.warn({ err }, "Kalshi authenticated HTTP pre-warm failed");
  });
}

/** Arm one self-correcting wall-clock timer; it never blocks market evaluation. */
export function startKalshiAuthTransportPrewarm(): void {
  if (prewarmTimer != null) return;
  const armNext = () => {
    const delayMs = Math.max(0, nextKalshiAuthPrewarmAtMs() - Date.now());
    prewarmTimer = setTimeout(() => {
      prewarmTimer = null;
      prewarmKalshiAuthTransport();
      armNext();
    }, delayMs);
    prewarmTimer.unref?.();
  };
  armNext();
}

export function _stopKalshiAuthTransportPrewarmForTesting(): void {
  if (prewarmTimer != null) clearTimeout(prewarmTimer);
  prewarmTimer = null;
}

export function _setKalshiAuthPrewarmRequestForTesting(
  request: (() => Promise<unknown>) | null,
): void {
  prewarmRequestForTesting = request;
}

function retryAfterMs(response: Response): number | null {
  const raw = response.headers.get("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

export function _resetAuthenticatedReadSchedulerForTesting(): void {
  authenticatedReadScheduler.resetForTesting();
}

/**
 * HTTP statuses that are safe to retry on idempotent reads: rate limits and
 * transient server errors. 4xx responses other than 429 are definitive.
 */
export function isRetryableKalshiReadStatus(status: number | undefined): boolean {
  return status === 429 || (typeof status === "number" && status >= 500);
}
function endpointCategory(path: string): string {
  return path.startsWith("/portfolio/fills") ? "portfolio_fills"
    : path.startsWith("/markets/") ? "market_result"
      : "other_get";
}

/**
 * Normalise a PEM key that may have been stored with spaces or literal \n
 * instead of real newlines, so OpenSSL can parse it correctly.
 */
function normalizePem(raw: string): string {
  // Step 1: replace literal \n sequences with real newlines
  let s = raw.replace(/\\n/g, "\n").trim();

  // Step 2: if the header and body are on the same line (spaces used instead
  // of newlines), split into proper 64-char-per-line PEM.
  const headerRe = /^(-----BEGIN [^-]+-----)\s+([A-Za-z0-9+/\s=]+?)\s*(-----END [^-]+-----)$/s;
  const m = s.match(headerRe);
  if (m) {
    const header = m[1];
    const body = m[2].replace(/\s+/g, ""); // strip any whitespace from base64
    const footer = m[3];
    // Split body into 64-char lines
    const lines = body.match(/.{1,64}/g) ?? [];
    s = [header, ...lines, footer].join("\n");
  }

  return s;
}

/**
 * Build the three Kalshi authentication headers.
 * Signature covers: timestampMs + METHOD + path (no query string).
 */
export function kalshiAuthHeaders(method: string, path: string): Record<string, string> {
  const keyId = process.env["KALSHI_API_KEY_ID"];
  const rawKey = process.env["KALSHI_PRIVATE_KEY"];

  if (!keyId || !rawKey) {
    throw new Error("KALSHI_API_KEY_ID and KALSHI_PRIVATE_KEY must be set");
  }

  // Secrets can arrive with literal \n, or with spaces replacing newlines.
  // Reconstruct a properly-formatted PEM in all cases.
  const pemKey = normalizePem(rawKey);

  const timestampMs = Date.now().toString();
  // Strip query string from path
  const cleanPath = path.split("?")[0];
  const message = timestampMs + method.toUpperCase() + cleanPath;

  const sign = createSign("SHA256");
  sign.update(message);
  sign.end();

  // PSS padding with salt length = digest length (32 bytes for SHA-256)
  const signature = sign.sign({
    key: pemKey,
    padding: 6,        // RSA_PKCS1_PSS_PADDING = 6
    saltLength: 32,    // DIGEST_LENGTH for SHA-256
  });

  return {
    "Content-Type": "application/json",
    "KALSHI-ACCESS-KEY": keyId,
    "KALSHI-ACCESS-SIGNATURE": signature.toString("base64"),
    "KALSHI-ACCESS-TIMESTAMP": timestampMs,
  };
}

// ── Diagnostic helper ─────────────────────────────────────────────────────────

export interface KalshiAuthDiagnostic {
  keyIdPresent: boolean;
  privateKeyPresent: boolean;
  pemNormalised: boolean;
  signingWorks: boolean;
  errors: string[];
}

/**
 * Run all six auth pre-flight checks synchronously without making any network
 * call. Returns a structured report so callers can fail fast with a clear error
 * instead of a silent 502.
 */
export function diagnoseKalshiAuth(): KalshiAuthDiagnostic {
  const errors: string[] = [];
  const result: KalshiAuthDiagnostic = {
    keyIdPresent:    false,
    privateKeyPresent: false,
    pemNormalised:   false,
    signingWorks:    false,
    errors,
  };

  const keyId  = process.env["KALSHI_API_KEY_ID"];
  const rawKey = process.env["KALSHI_PRIVATE_KEY"];

  result.keyIdPresent = Boolean(keyId && keyId.length > 0);
  if (!result.keyIdPresent) errors.push("KALSHI_API_KEY_ID is not set or empty");

  result.privateKeyPresent = Boolean(rawKey && rawKey.length > 0);
  if (!result.privateKeyPresent) errors.push("KALSHI_PRIVATE_KEY is not set or empty");

  if (rawKey) {
    let pem: string;
    try {
      pem = normalizePem(rawKey);
      result.pemNormalised = true;
    } catch (e) {
      errors.push(`PEM normalisation failed: ${String(e)}`);
      return result;
    }

    try {
      const sign = createSign("SHA256");
      sign.update("kalshi-auth-preflight");
      sign.end();
      sign.sign({ key: pem, padding: 6, saltLength: 32 });
      result.signingWorks = true;
    } catch (e) {
      errors.push(`RSA-PSS signing failed: ${String(e)}`);
    }
  }

  return result;
}

/**
 * Stable, non-reversible identifier for the configured Kalshi credential source.
 * This deliberately never returns the access-key ID, private key, or an account
 * identifier. It is for comparing the runtime that signs orders with the
 * runtime that reads account history.
 */
export function getKalshiCredentialFingerprint(): string | null {
  const keyId = process.env["KALSHI_API_KEY_ID"];
  if (!keyId) return null;
  return `sha256:${createHash("sha256").update(`kalshi-credential-source:v1:${keyId}`).digest("hex").slice(0, 16)}`;
}

/**
 * Authenticated fetch against the Kalshi external-api (trade-capable) host.
 */
export async function kalshiAuthFetch<T>(
  method: string,
  path: string,
  body?: unknown,
  options: { readPriority?: KalshiAuthenticatedReadPriority } = {},
): Promise<T> {
  const url = `${KALSHI_TRADE_BASE}${path}`;
  const isRetryableRead = method.toUpperCase() === "GET" && body === undefined;
  const maxAttempts = isRetryableRead ? GET_RETRY_DELAYS_MS.length + 1 : 1;
  const startedAt = Date.now();
  let lastError: unknown;
  let retriesPerformed = 0;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      // Re-sign every retry because Kalshi timestamps are part of the signature.
      const request = async () => {
        const headers = kalshiAuthHeaders(method, `/trade-api/v2${path}`);
        return fetch(url, {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
      };
      const response = isRetryableRead
        ? await authenticatedReadScheduler.run(request, options.readPriority ?? "normal")
        : await request();
      const text = await response.text();
      if (!response.ok) {
        let parsed: unknown;
        try { parsed = JSON.parse(text); } catch { parsed = text; }
        const httpError = Object.assign(new Error(`Kalshi auth API error ${response.status}`), {
          status: response.status, body: parsed, retryAfterMs: retryAfterMs(response),
        });
        // A named class makes rate limits distinguishable in the read-network
        // telemetry ("Error" alone hid the 2026-08-17 429 storm root cause).
        httpError.name = `KalshiHttp${response.status}`;
        throw httpError;
      }
      if (attempt > 0) readNetworkEventSink?.({
        endpointCategory: endpointCategory(path), errorClass: null, elapsedMs: Date.now() - startedAt,
        retryCount: attempt, recoveryOutcome: "recovered",
      });
      return JSON.parse(text) as T;
    } catch (err) {
      lastError = err;
      // Most HTTP responses are definitive and must not be retried; rate
      // limits (429) and transient 5xx on idempotent reads receive the same
      // bounded retry as transport failures.
      const status = (err as { status?: number }).status;
      if (!isRetryableRead || (status !== undefined && !isRetryableKalshiReadStatus(status)) || attempt === maxAttempts - 1) break;
      retriesPerformed++;
      const retryDelay = Math.max(
        GET_RETRY_DELAYS_MS[attempt]!,
        status === 429 ? ((err as { retryAfterMs?: number }).retryAfterMs ?? 0) : 0,
      );
      if (status === 429) authenticatedReadScheduler.coolDown(retryDelay);
      await new Promise<void>((resolve) => setTimeout(resolve, retryDelay));
    }
  }
  if (isRetryableRead) readNetworkEventSink?.({
    endpointCategory: endpointCategory(path),
    errorClass: lastError instanceof Error ? lastError.name : "UnknownError",
    elapsedMs: Date.now() - startedAt, retryCount: retriesPerformed, recoveryOutcome: "failed",
  });
  throw lastError;
}
