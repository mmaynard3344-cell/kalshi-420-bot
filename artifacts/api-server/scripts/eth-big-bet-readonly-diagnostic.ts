import { withBoundedReadOnlyClient } from "../../../lib/db/src/index.js";
import { kalshiAuthFetch } from "../src/lib/kalshiAuth.js";
import { ethBigBetCapitalRiskCents } from "../src/lib/strategies/ethBigBetLifecycle.js";

async function main(): Promise<void> {
  const rows = await withBoundedReadOnlyClient(10_000, async (client) => {
    const result = await client.query(`
      SELECT id, strategy, order_tag, ticker, market_open_time_ms, side,
             wager_cents, limit_price_cents, requested_contracts,
             kalshi_order_id, status, filled_contracts,
             actual_notional_cents, actual_fee_cents, fill_price_cents,
             settlement_result, realized_pnl_cents,
             created_at_ms, updated_at_ms
      FROM eth_big_bet_orders
      WHERE strategy IN ('jump','reversal')
        AND status NOT IN ('rejected','settled')
      ORDER BY created_at_ms ASC
    `);
    return result.rows as Array<Record<string, unknown>>;
  });

  console.log(`ETH_BIG_BET_READONLY_DIAGNOSTIC ${JSON.stringify({
    ethBWagerCents: process.env["ETH_B_WAGER_CENTS"] ?? null,
    unresolvedCount: rows.length,
  })}`);

  for (const row of rows) {
    const id = String(row["id"] ?? "");
    const ticker = String(row["ticker"] ?? "");
    const wager = Number(row["wager_cents"]);
    const limit = Number(row["limit_price_cents"]);
    const risk = Number.isSafeInteger(wager) && Number.isSafeInteger(limit)
      ? ethBigBetCapitalRiskCents(wager, limit)
      : null;

    let exchangeByClient: unknown = null;
    let exchangeById: unknown = null;
    try {
      const raw = await kalshiAuthFetch<{ orders?: Array<Record<string, unknown>> }>(
        "GET",
        `/portfolio/orders?client_order_id=${encodeURIComponent(id)}&ticker=${encodeURIComponent(ticker)}&limit=100`,
      );
      const matches = (raw.orders ?? []).filter((o) => o["client_order_id"] === id && o["ticker"] === ticker);
      exchangeByClient = matches.map((o) => ({
        order_id: o["order_id"] ?? null,
        client_order_id: o["client_order_id"] ?? null,
        ticker: o["ticker"] ?? null,
        status: o["status"] ?? null,
        fill_count: o["fill_count"] ?? null,
        remaining_count: o["remaining_count"] ?? null,
        side: o["side"] ?? null,
        yes_price: o["yes_price"] ?? null,
        no_price: o["no_price"] ?? null,
        created_time: o["created_time"] ?? null,
      }));
    } catch (err) {
      exchangeByClient = { error: err instanceof Error ? err.message : String(err) };
    }

    const kalshiOrderId = typeof row["kalshi_order_id"] === "string" && row["kalshi_order_id"]
      ? row["kalshi_order_id"]
      : null;
    if (kalshiOrderId) {
      try {
        const raw = await kalshiAuthFetch<{ order?: Record<string, unknown> }>(
          "GET",
          `/portfolio/orders/${encodeURIComponent(kalshiOrderId)}`,
        );
        const o = raw.order ?? {};
        exchangeById = {
          order_id: o["order_id"] ?? null,
          client_order_id: o["client_order_id"] ?? null,
          ticker: o["ticker"] ?? null,
          status: o["status"] ?? null,
          fill_count: o["fill_count"] ?? null,
          remaining_count: o["remaining_count"] ?? null,
          side: o["side"] ?? null,
          yes_price: o["yes_price"] ?? null,
          no_price: o["no_price"] ?? null,
          created_time: o["created_time"] ?? null,
        };
      } catch (err) {
        exchangeById = { error: err instanceof Error ? err.message : String(err) };
      }
    }

    const payload = {
      id,
      strategy: row["strategy"],
      ticker,
      kalshiOrderId,
      status: row["status"],
      createdAtMs: row["created_at_ms"],
      calculatedRiskCents: risk,
      wagerCents: row["wager_cents"],
      limitPriceCents: row["limit_price_cents"],
      exchangeByClient,
      exchangeById,
    };
    console.log(`ETH_BIG_BET_ROW ${JSON.stringify(payload)}`);
  }
}

void main().catch((err) => {
  console.error(`ETH_BIG_BET_READONLY_DIAGNOSTIC_THROWN ${JSON.stringify({
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : null,
  })}`);
  process.exitCode = 2;
});
