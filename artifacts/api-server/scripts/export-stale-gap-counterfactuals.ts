/**
 * Export passive stale-gap counterfactual capture records from PostgreSQL.
 * Usage: pnpm --filter @workspace/api-server run export:stale-gap-counterfactuals -- [--from=ISO] [--to=ISO]
 * Output: newline-delimited JSON, one stored analysis payload per line.
 */
function arg(name: string): string | undefined {
  return process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
}
function toMs(value: string | undefined, name: string): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`Invalid --${name} ISO timestamp: ${value}`);
  return ms;
}

const from = toMs(arg("from"), "from");
const to = toMs(arg("to"), "to");
const [{ asc, gte, lte, and }, { db, staleGapCounterfactualCaptures }] = await Promise.all([
  import("drizzle-orm"),
  import("@workspace/db"),
]);
const where = and(
  from === undefined ? undefined : gte(staleGapCounterfactualCaptures.timestampMs, from),
  to === undefined ? undefined : lte(staleGapCounterfactualCaptures.timestampMs, to),
);
const rows = await db.select({ payload: staleGapCounterfactualCaptures.payload })
  .from(staleGapCounterfactualCaptures)
  .where(where)
  .orderBy(asc(staleGapCounterfactualCaptures.timestampMs), asc(staleGapCounterfactualCaptures.captureId));
for (const row of rows) process.stdout.write(`${JSON.stringify(row.payload)}\n`);