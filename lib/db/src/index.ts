import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;
const POOL_MAX_CLIENTS = 5;
// Keep one of the five pool clients available for trading-safety writes. Dashboard
// reads are bounded independently so a browser refresh burst cannot make an
// awaited heartbeat or settlement persistence wait behind every read.
const MAX_CONCURRENT_BOUNDED_READS = POOL_MAX_CLIENTS - 1;
let activeBoundedReadOnlyClients = 0;
const boundedReadWaiters: Array<() => void> = [];

/**
 * Non-sensitive live occupancy of the dashboard read lane. This deliberately
 * contains no query, caller, or connection details: it is only operational
 * telemetry explaining why a dashboard request may be waiting.
 */
export interface BoundedReadOnlyStatus {
  activeReadCount: number;
  queueDepth: number;
  maxConcurrentReads: number;
  reservedSafetyClients: number;
}

export function getBoundedReadOnlyStatus(): BoundedReadOnlyStatus {
  return {
    activeReadCount: activeBoundedReadOnlyClients,
    queueDepth: boundedReadWaiters.length,
    maxConcurrentReads: MAX_CONCURRENT_BOUNDED_READS,
    reservedSafetyClients: POOL_MAX_CLIENTS - MAX_CONCURRENT_BOUNDED_READS,
  };
}

async function acquireBoundedReadSlot(): Promise<void> {
  if (activeBoundedReadOnlyClients < MAX_CONCURRENT_BOUNDED_READS) {
    activeBoundedReadOnlyClients++;
    return;
  }
  await new Promise<void>((resolve) => boundedReadWaiters.push(resolve));
}

function releaseBoundedReadSlot(): void {
  const next = boundedReadWaiters.shift();
  if (next) {
    // Hand the existing slot directly to the next waiter.
    next();
    return;
  }
  activeBoundedReadOnlyClients--;
}

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

function createPool(): pg.Pool {
  const p = new Pool({
    connectionString:              process.env.DATABASE_URL,
    // Keep idle connections alive so the server-side idle timeout doesn't drop
    // them silently.  Without this, pg-pool reuses a connection the DB has
    // already closed, producing "Authentication timed out" (08P01) on the next
    // query and forcing a full storage-degraded recovery cycle.
    keepAlive:                     true,
    keepAliveInitialDelayMillis:   10_000,
    // Cap pool size and add a connect timeout so startup failures are fast.
    max:                           POOL_MAX_CLIENTS,
    connectionTimeoutMillis:       10_000,
    idleTimeoutMillis:             30_000,
  });
  // An idle client can emit 'error' (backend restart, network reset) outside
  // any query.  Without a listener, Node treats it as an unhandled 'error'
  // event and CRASHES the process — fatal for unattended trading.  The pool
  // discards the broken client automatically; we only need to log.
  p.on("error", (err) => {
    console.error(
      "[db] idle pool client error (handled — pool will discard the connection):",
      err instanceof Error ? err.message : err,
    );
  });
  return p;
}

function createDb(p: pg.Pool) {
  return drizzle(p, { schema });
}

export let pool = createPool();
export let db   = createDb(pool);

/**
 * Run a dashboard-style read in a transaction that has a server-enforced
 * statement deadline. The caller receives a bounded result and the checked-out
 * client is always released (and discarded after an error), so an interrupted
 * read cannot silently consume a shared pool slot.
 *
 * This helper is intentionally read-only. Trading and ledger mutations continue
 * to use the existing Drizzle database handle and are not affected by it.
 */
export async function withBoundedReadOnlyClient<T>(
  timeoutMs: number,
  operation: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  await acquireBoundedReadSlot();
  try {
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const connect = pool.connect();
    const client = await Promise.race([
      connect,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new Error(`database read client acquisition timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]).catch((err) => {
      // A queued pool acquisition may resolve after the caller has already
      // failed. Release that late client immediately so it cannot leak a slot.
      if (timedOut) void connect.then((lateClient) => lateClient.release(true)).catch(() => {});
      throw err;
    }).finally(() => {
      if (timer) clearTimeout(timer);
    });

    let released = false;
    let discardClient = false;
    const release = (discard: boolean) => {
      if (released) return;
      released = true;
      client.release(discard);
    };
    let operationTimer: ReturnType<typeof setTimeout> | null = null;
    const deadline = new Promise<never>((_, reject) => {
      operationTimer = setTimeout(() => {
        discardClient = true;
        // pg-pool removes a client released with an error, closing its socket
        // instead of returning an interrupted query to the five-slot pool.
        release(true);
        reject(new Error(`database read timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    try {
      return await Promise.race([
        (async () => {
          await client.query("BEGIN READ ONLY");
          await client.query("SELECT set_config('statement_timeout', $1, true)", [String(timeoutMs)]);
          return operation(client);
        })(),
        deadline,
      ]);
    } catch (err) {
      // Do not return a client that encountered a cancelled or network-failed
      // query to the shared pool. The pool replaces it on the next checkout.
      discardClient = true;
      throw err;
    } finally {
      if (operationTimer) clearTimeout(operationTimer);
      if (!released && !discardClient) await client.query("ROLLBACK").catch(() => { discardClient = true; });
      release(discardClient);
    }
  } finally {
    releaseBoundedReadSlot();
  }
}

/**
 * Tear down the current pool and build a fresh one (new sockets, fresh DNS
 * resolution).  Used by tradeStore's reconnect loop when repeated pings keep
 * timing out — a provider-side endpoint move or half-dead sockets can leave
 * the old pool permanently unable to connect even though the database itself
 * has recovered.  The old pool is ended in the background; in-flight queries
 * on it fail fast rather than hanging.
 */
export function resetDatabasePool(): typeof db {
  const old = pool;
  pool = createPool();
  db   = createDb(pool);
  void old.end().catch(() => { /* already ended / broken — nothing to do */ });
  return db;
}

export * from "./schema";
