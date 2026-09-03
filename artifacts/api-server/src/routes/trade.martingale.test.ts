import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import express from "express";

process.env["TRADE_API_TOKEN"] = "martingale-ledger-test-token";
delete process.env["VITE_TRADE_API_TOKEN"];

test("martingale ledger outage returns promptly and recovers after storage returns", async () => {
  const tradeStore = await import("../lib/tradeStore.js");
  const { default: tradeRouter } = await import("./trade.js");
  let initialised = false;
  let available = false;
  const database = {
    execute: async () => {
      if (!initialised) {
        initialised = true;
        return { rows: [{ "?column?": 1 }] };
      }
      if (!available) return new Promise<never>(() => {});
      return { rows: [{ "?column?": 1 }] };
    },
  };
  await tradeStore.initTradeStore(database as never);
  tradeStore._setEthMartingaleLedgerReadTimeoutForTesting(15);

  const app = express();
  app.use(tradeRouter);
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    const startedAt = Date.now();
    const unavailable = await fetch(`http://127.0.0.1:${address.port}/trade/martingale`, {
      headers: { "X-Trade-Token": "martingale-ledger-test-token" },
    });
    assert.ok(Date.now() - startedAt < 500, "the unavailable dashboard response must be bounded");
    assert.equal(unavailable.status, 503);
    assert.deepEqual(await unavailable.json(), {
      error: "Martingale ledger is temporarily unavailable",
      code: "MARTINGALE_LEDGER_UNAVAILABLE",
      retry_after_seconds: 5,
      storage_status: "healthy",
    });
    assert.equal(tradeStore.isStorageHealthy(), true, "a dashboard-only read must not change trading storage health");

    available = true;
    const recovered = await fetch(`http://127.0.0.1:${address.port}/trade/martingale`, {
      headers: { "X-Trade-Token": "martingale-ledger-test-token" },
    });
    assert.equal(recovered.status, 200, "the next dashboard poll must recover after storage returns");
  } finally {
    tradeStore._setEthMartingaleLedgerReadTimeoutForTesting(null);
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  }
});

test("ETH manual recovery requires a separate server-only credential", async () => {
  const { default: tradeRouter } = await import("./trade.js");
  const app = express();
  app.use(express.json());
  app.use(tradeRouter);
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/trade/martingale/recovery`;
  const body = {
    acknowledgement: "MANUALLY_SETTLE_AND_RESET_ETH_TO_NO_BASE",
    declared_result: "yes",
    reason: "Kalshi market is closed but still has no official result",
  };
  try {
    delete process.env["ETH_MARTINGALE_RECOVERY_TOKEN"];
    const unconfigured = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Trade-Token": "martingale-ledger-test-token" },
      body: JSON.stringify(body),
    });
    assert.equal(unconfigured.status, 503);

    process.env["ETH_MARTINGALE_RECOVERY_TOKEN"] = "server-only-recovery-test-token";
    const invalidRecoveryCredential = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Trade-Token": "martingale-ledger-test-token",
        "X-ETH-Recovery-Token": "not-the-server-secret",
      },
      body: JSON.stringify(body),
    });
    assert.equal(invalidRecoveryCredential.status, 401);

    process.env["ETH_MARTINGALE_RECOVERY_TOKEN"] = "martingale-ledger-test-token";
    const duplicatedTradeCredential = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Trade-Token": "martingale-ledger-test-token",
        "X-ETH-Recovery-Token": "martingale-ledger-test-token",
      },
      body: JSON.stringify(body),
    });
    assert.equal(duplicatedTradeCredential.status, 503);
  } finally {
    delete process.env["ETH_MARTINGALE_RECOVERY_TOKEN"];
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  }
});

test("ETH 420 candidate step reset requires both distinct operator credentials", async () => {
  const { default: tradeRouter } = await import("./trade.js");
  const app = express();
  app.use(tradeRouter);
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/trade/eth420-candidate/reset-step`;
  try {
    delete process.env["ETH_MARTINGALE_RECOVERY_TOKEN"];
    assert.equal((await fetch(url, { method: "POST" })).status, 401);
    assert.equal((await fetch(url, {
      method: "POST", headers: { "X-Trade-Token": "martingale-ledger-test-token" },
    })).status, 503);

    process.env["ETH_MARTINGALE_RECOVERY_TOKEN"] = "server-only-recovery-test-token";
    assert.equal((await fetch(url, {
      method: "POST",
      headers: {
        "X-Trade-Token": "martingale-ledger-test-token",
        "X-ETH-Recovery-Token": "wrong-recovery-token",
      },
    })).status, 401);
    assert.equal((await fetch(url, {
      method: "POST",
      headers: {
        "X-Trade-Token": "martingale-ledger-test-token",
        "X-ETH-Recovery-Token": "server-only-recovery-test-token",
      },
    })).status, 503, "a correctly authenticated reset must still fail closed when storage is unavailable");
  } finally {
    delete process.env["ETH_MARTINGALE_RECOVERY_TOKEN"];
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  }
});

test("ETH420 emergency reduction is server-only and rejects missing typed command without exchange invocation", async () => {
  const { default: tradeRouter } = await import("./trade.js");
  const app = express();
  app.use(express.json());
  app.use(tradeRouter);
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/trade/eth420-candidate/emergency-reduce`;
  try {
    process.env["ETH_MARTINGALE_RECOVERY_TOKEN"] = "server-only-recovery-test-token";
    assert.equal((await fetch(url, { method: "POST" })).status, 401);
    const invalid = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Trade-Token": "martingale-ledger-test-token", "X-ETH-Recovery-Token": "server-only-recovery-test-token" },
      body: JSON.stringify({ confirmation: "wrong", reason: "short" }),
    });
    assert.equal(invalid.status, 400);
  } finally {
    delete process.env["ETH_MARTINGALE_RECOVERY_TOKEN"];
    server.closeAllConnections(); server.close(); await once(server, "close");
  }
});

test("ETH manual recovery accepts a declared outcome that differs from the filled order side", async () => {
  const tradeStore = await import("../lib/tradeStore.js");
  const writes: unknown[] = [];
  const tx = {
    execute: async (query: unknown) => {
      writes.push(query);
      const call = writes.length;
      if (call === 1) return { rows: [] }; // no prior recovery audit
      if (call === 2) return {
        rows: [{
          id: "eth-entry:current", ticker: "KXETH15M-EXAMPLE", eastern_date: "2026-08-28",
          side: "yes", martingale_step: 1, outcome: "full_fill", filled_contracts: 60,
          kalshi_order_id: "kalshi-order-id",
        }],
      };
      if (call === 3) return {
        rows: [{ eastern_date: "2026-08-28", side: "yes", martingale_step: 1, spent_cents: 6000, realized_pnl_cents: 919 }],
      };
      return { rows: [], rowCount: 1 };
    },
  };
  const database = {
    execute: async () => ({ rows: [], rowCount: 1 }),
    transaction: async <T>(work: (transaction: typeof tx) => Promise<T>) => work(tx),
  };
  await tradeStore.initTradeStore(database as never);
  const result = await tradeStore.manuallyRecoverEthMartingaleOrder({
    orderId: "eth-entry:current",
    // The manual declaration describes the market result, not the outcome that
    // was purchased. A reset-only recovery must support either result.
    declaredResult: "no",
    reason: "Kalshi market closed without an official settlement result",
    acknowledgement: "MANUALLY_SETTLE_AND_RESET_ETH_TO_NO_BASE",
    exchangeStatus: "closed",
  });
  assert.equal(result.kind, "applied");
  assert.equal(writes.length, 6, "recovery uses audit + order + state locks and exactly three transactional writes");
});

test("manual ETH recovery markers do not count as official settled outcomes", async () => {
  const tradeStore = await import("../lib/tradeStore.js");
  const manualOrder = {
    side: "yes" as const,
    settlementResult: "manual_yes" as const,
    createdAtMs: 1,
    filledContracts: 60,
    actualNotionalDollars: 30,
    actualFeeDollars: 1,
  };
  const summary = tradeStore.summarizeEthMartingaleOrders([manualOrder]);
  assert.equal(summary.wins, 0);
  assert.equal(summary.losses, 0);
  assert.equal(summary.streak, 0);
  assert.equal(tradeStore.findOpenEthMartingalePosition([{
    ...manualOrder,
    ticker: "KXETH15M-EXAMPLE",
    requestedContracts: 60,
    outcome: "full_fill",
  }]), null);
});