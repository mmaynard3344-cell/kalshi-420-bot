import { createHash } from "node:crypto";

export interface Phase4BExportRecord {
  recordType: string;
  capturedAtMs: number;
  marketId: string;
  snapshotId?: string | null;
  side?: string | null;
  payload: Readonly<Record<string, unknown>>;
}

export function exportPhase4BNdjson(records: readonly Phase4BExportRecord[]) {
  const ordered = [...records].sort((a, b) =>
    a.capturedAtMs - b.capturedAtMs || a.marketId.localeCompare(b.marketId)
      || (a.snapshotId ?? "").localeCompare(b.snapshotId ?? "") || a.recordType.localeCompare(b.recordType)
      || (a.side ?? "").localeCompare(b.side ?? ""));
  const ndjson = ordered.map((record) => JSON.stringify(record)).join("\n") + (ordered.length ? "\n" : "");
  const counts = ordered.reduce<Record<string, number>>((all, record) => ({ ...all, [record.recordType]: (all[record.recordType] ?? 0) + 1 }), {});
  const unresolvedOutcomes = ordered.filter((record) => record.recordType === "outcome" && record.payload["result"] == null).length;
  return {
    ndjson,
    manifest: {
      schemaVersion: "1", startMs: ordered[0]?.capturedAtMs ?? null, endMs: ordered.at(-1)?.capturedAtMs ?? null,
      recordCounts: counts, unresolvedOutcomes,
      digestSha256: createHash("sha256").update(ndjson).digest("hex"),
      ordering: ["capturedAtMs", "marketId", "snapshotId", "recordType", "side"],
    },
  };
}