import { build } from "esbuild";
import { writeFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

const rootDir = path.resolve(".");
const apiDir = path.resolve("artifacts/api-server");
const entry = "/tmp/eth-big-bet-unresolved-diagnostic-entry.ts";
const outfile = "/tmp/eth-big-bet-unresolved-diagnostic-entry.cjs";

const source = `
import { withBoundedReadOnlyClient } from ${JSON.stringify(path.join(rootDir, "lib/db/src/index.ts"))};
import { kalshiAuthFetch } from ${JSON.stringify(path.join(apiDir, "src/lib/kalshiAuth.ts"))};
import { ethBigBetCapitalRiskCents } from ${JSON.stringify(path.join(apiDir, "src/lib/strategies/ethBigBetLifecycle.ts"))};

async function main() {
  const rows = await withBoundedReadOnlyClient(10000, async (client) => {
    const result = await client.query(`SELECT id, strategy, order_tag, ticker, market_open_time_ms, side,
           wager_cents, limit_price_cents, requested_contracts,
           kalshi_order_id, status, filled_contracts,
           actual_notional_cents, actual_fee_cents, fill_price_cents,
           settlement_result, realized_pnl_cents,
           created_at_ms, updated_at_ms
      FROM eth_big_bet_orders
      WHERE status NOT IN ('rejected','settled')
         OR id = 'KXETH15M-26SEP131830-30:eth-jump-v1'
      ORDER BY created_at_ms ASC`);
    return result.rows;
  });
  console.log("ETH_BIG_BET_READONLY_DIAGNOSTIC", {
    ethBWagerCents: process.env.ETH_B_WAGER_CENTS ?? null,
    unresolvedOrTargetCount: rows.length,
  });
  for (const row of rows) {
    const wager = Number(row.wager_cents);
    const limit = Number(row.limit_price_cents);
    const risk = Number.isSafeInteger(wager) && Number.isSafeInteger(limit)
      ? ethBigBetCapitalRiskCents(wager, limit)
      : null;
    let exchangeByClient = null;
    let exchangeById = null;
    try {
      const raw = await kalshiAuthFetch(
        "GET",
        `/portfolio/orders?client_order_id=${encodeURIComponent(String(row.id))}&ticker=${encodeURIComponent(String(row.ticker))}&limit=100`,
      );
      const matches = Array.isArray(raw?.orders)
        ? raw.orders.filter((o) => o?.client_order_id === row.id && o?.ticker === row.ticker)
        : [];
      exchangeByClient = matches.map((o) => ({
        order_id: o?.order_id ?? null,
        client_order_id: o?.client_order_id ?? null,
        ticker: o?.ticker ?? null,
        status: o?.status ?? null,
        fill_count: o?.fill_count ?? null,
        remaining_count: o?.remaining_count ?? null,
        side: o?.side ?? null,
        yes_price: o?.yes_price ?? null,
        no_price: o?.no_price ?? null,
        created_time: o?.created_time ?? null,
      }));
    } catch (err) {
      exchangeByClient = { error: err instanceof Error ? err.message : String(err) };
    }
    if (typeof row.kalshi_order_id === "string" && row.kalshi_order_id) {
      try {
        const raw = await kalshiAuthFetch("GET", `/portfolio/orders/${encodeURIComponent(row.kalshi_order_id)}`);
        const o = raw?.order ?? raw;
        exchangeById = {
          order_id: o?.order_id ?? null,
          client_order_id: o?.client_order_id ?? null,
          ticker: o?.ticker ?? null,
          status: o?.status ?? null,
          fill_count: o?.fill_count ?? null,
          remaining_count: o?.remaining_count ?? null,
          side: o?.side ?? null,
          yes_price: o?.yes_price ?? null,
          no_price: o?.no_price ?? null,
          created_time: o?.created_time ?? null,
        };
      } catch (err) {
        exchangeById = { error: err instanceof Error ? err.message : String(err) };
      }
    }
    console.log("ETH_BIG_BET_ROW", {
      id: row.id,
      strategy: row.strategy,
      orderTag: row.order_tag,
      ticker: row.ticker,
      marketOpenTimeMs: row.market_open_time_ms,
      side: row.side,
      wagerCents: row.wager_cents,
      limitPriceCents: row.limit_price_cents,
      requestedContracts: row.requested_contracts,
      calculatedRiskCents: risk,
      kalshiOrderId: row.kalshi_order_id,
      status: row.status,
      filledContracts: row.filled_contracts,
      actualNotionalCents: row.actual_notional_cents,
      actualFeeCents: row.actual_fee_cents,
      fillPriceCents: row.fill_price_cents,
      settlementResult: row.settlement_result,
      realizedPnlCents: row.realized_pnl_cents,
      createdAtMs: row.created_at_ms,
      updatedAtMs: row.updated_at_ms,
      exchangeByClient,
      exchangeById,
    });
  }
}

void main().catch((err) => {
  console.error("ETH_BIG_BET_READONLY_DIAGNOSTIC_THROWN", {
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : null,
  });
  process.exitCode = 2;
});
`;

await writeFile(entry, source, "utf8");
try {
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    sourcemap: false,
    logLevel: "silent",
    external: ["pg-native"],
  });
  const run = spawnSync(process.execPath, [outfile], { stdio: "inherit", env: process.env });
  if (run.error) throw run.error;
  if (run.status !== 0) process.exitCode = run.status ?? 1;
} finally {
  await rm(entry, { force: true });
  await rm(outfile, { force: true });
}
