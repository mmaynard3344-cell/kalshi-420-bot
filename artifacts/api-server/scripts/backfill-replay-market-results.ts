/**
 * Resolve and durably record missing settlement labels for a replay audit.
 *
 * Usage:
 *   pnpm --filter @workspace/api-server exec tsx scripts/backfill-replay-market-results.ts
 *     [path/to/local-outcomes.json]
 *
 * Safety rules:
 * - Existing market_results rows are never changed.
 * - Only Kalshi responses with market.result === "yes" | "no" are inserted.
 * - Each run writes an audit report; unresolved/error responses remain untouched.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { kalshiAuthFetch } from "../src/lib/kalshiAuth.js";

type Result = "yes" | "no";

interface AuditInputRow {
  ticker: string;
  result: Result | null;
  cache_result: Result | null;
  analysis_source: string;
}

interface KalshiMarketResponse {
  market?: { result?: unknown; status?: unknown };
}

const DEFAULT_INPUT = join(
  process.cwd(),
  "data",
  "analysis",
  "replay-3c74e738-local-outcomes.json",
);
const inputPath = process.argv[2] ?? DEFAULT_INPUT;
const startedAt = new Date().toISOString();
// `pg` is owned by the shared database workspace, not the API package.
// Resolve it explicitly so this standalone operational script needs no new dependency.
const dbRequire = createRequire(join(process.cwd(), "..", "..", "lib", "db", "package.json"));
const pg = dbRequire("pg") as typeof import("pg");
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });

const input = JSON.parse(readFileSync(inputPath, "utf8")) as { rows?: AuditInputRow[] };
if (!Array.isArray(input.rows)) throw new Error("Audit input must contain a rows array.");

const unresolved = input.rows
  .filter((row) => row.result === null && row.analysis_source === "unresolved")
  .map((row) => row.ticker)
  .filter((ticker): ticker is string => typeof ticker === "string" && ticker.length > 0);

const existingRows = unresolved.length === 0
  ? []
  : (await pool.query(
    "SELECT ticker, result FROM market_results WHERE ticker = ANY($1::text[])",
    [unresolved],
  )).rows;
const existing = new Map(existingRows.map((row) => [String(row.ticker), String(row.result)]));

const audit: Array<Record<string, unknown>> = [];
const inserted: string[] = [];

for (const ticker of unresolved) {
  const alreadyStored = existing.get(ticker);
  if (alreadyStored === "yes" || alreadyStored === "no") {
    audit.push({ ticker, action: "unchanged_existing", result: alreadyStored });
    continue;
  }

  try {
    const response = await kalshiAuthFetch<KalshiMarketResponse>("GET", `/markets/${ticker}`);
    const result = response.market?.result;
    if (result !== "yes" && result !== "no") {
      audit.push({
        ticker,
        action: "unresolved",
        marketStatus: typeof response.market?.status === "string" ? response.market.status : null,
        marketResult: typeof result === "string" ? result : null,
      });
      continue;
    }

    // This condition means a concurrent writer recorded an authoritative value
    // after the initial read. Preserve it rather than overwrite it.
    const written = await pool.query(
      `INSERT INTO market_results (ticker, result, resolved_at_ms)
       VALUES ($1, $2, $3)
       ON CONFLICT (ticker) DO NOTHING
       RETURNING ticker`,
      [ticker, result, Date.now()],
    );

    if (written.rowCount > 0) {
      inserted.push(ticker);
      audit.push({ ticker, action: "inserted_kalshi_verified", result, marketStatus: response.market?.status ?? null });
    } else {
      const concurrent = await pool.query(
        "SELECT result FROM market_results WHERE ticker = $1 LIMIT 1",
        [ticker],
      );
      audit.push({
        ticker,
        action: "unchanged_concurrent",
        result: concurrent.rows[0]?.result ?? null,
        kalshiResult: result,
      });
    }
  } catch (error) {
    const err = error as { message?: string; status?: number };
    audit.push({ ticker, action: "error", status: err.status ?? null, message: err.message ?? String(error) });
  }
}

const report = {
  startedAt,
  completedAt: new Date().toISOString(),
  inputPath,
  candidateCount: unresolved.length,
  insertedCount: inserted.length,
  unchangedCount: audit.filter((entry) => String(entry.action).startsWith("unchanged")).length,
  unresolvedCount: audit.filter((entry) => entry.action === "unresolved").length,
  errorCount: audit.filter((entry) => entry.action === "error").length,
  rows: audit,
};
const outputPath = join(
  dirname(inputPath),
  "replay-3c74e738-kalshi-market-results-backfill-audit.json",
);
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, JSON.stringify(report, null, 2) + "\n");
await pool.end();

console.log(JSON.stringify({
  candidateCount: report.candidateCount,
  insertedCount: report.insertedCount,
  unchangedCount: report.unchangedCount,
  unresolvedCount: report.unresolvedCount,
  errorCount: report.errorCount,
  audit: outputPath,
}, null, 2));