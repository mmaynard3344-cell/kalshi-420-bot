/**
 * Local read-only Phase 4B capture summary.
 *
 * Run: pnpm exec tsx scripts/stale-state-report.ts
 */
import {
  asc,
  count,
  max,
  min,
  sql,
} from "drizzle-orm";
import {
  db,
  phase4bDecisionSnapshots,
  phase4bMarketIntervals,
} from "@workspace/db";

const [intervalSummary] = await db
  .select({
    count: count(),
  })
  .from(phase4bMarketIntervals);

const [decisionSummary] = await db
  .select({
    count: count(),
    earliestTimestamp: min(phase4bDecisionSnapshots.capturedAtMs),
    latestTimestamp: max(phase4bDecisionSnapshots.capturedAtMs),
  })
  .from(phase4bDecisionSnapshots);

const finalDecisionCounts = await db
  .select({
    finalDecision: sql<string>`coalesce(${phase4bDecisionSnapshots.payload}->>'decisionClassification', 'unknown')`,
    count: count(),
  })
  .from(phase4bDecisionSnapshots)
  .groupBy(sql`coalesce(${phase4bDecisionSnapshots.payload}->>'decisionClassification', 'unknown')`)
  .orderBy(asc(sql`coalesce(${phase4bDecisionSnapshots.payload}->>'decisionClassification', 'unknown')`));

const rejectionReasonCounts = await db
  .select({
    rejectionReason: sql<string>`coalesce(${phase4bDecisionSnapshots.payload}->>'skipReason', 'none')`,
    count: count(),
  })
  .from(phase4bDecisionSnapshots)
  .groupBy(sql`coalesce(${phase4bDecisionSnapshots.payload}->>'skipReason', 'none')`)
  .orderBy(asc(sql`coalesce(${phase4bDecisionSnapshots.payload}->>'skipReason', 'none')`));

console.log(JSON.stringify({
  phase4bIntervalCount: Number(intervalSummary?.count ?? 0),
  phase4bDecisionCount: Number(decisionSummary?.count ?? 0),
  earliestTimestamp: decisionSummary?.earliestTimestamp == null
    ? null
    : new Date(Number(decisionSummary.earliestTimestamp)).toISOString(),
  latestTimestamp: decisionSummary?.latestTimestamp == null
    ? null
    : new Date(Number(decisionSummary.latestTimestamp)).toISOString(),
  decisionsByFinalDecision: finalDecisionCounts.map((row) => ({
    finalDecision: row.finalDecision,
    count: Number(row.count),
  })),
  decisionsByRejectionReason: rejectionReasonCounts.map((row) => ({
    rejectionReason: row.rejectionReason,
    count: Number(row.count),
  })),
}, null, 2));