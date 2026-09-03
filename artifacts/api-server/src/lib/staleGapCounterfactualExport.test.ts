import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";

describe("stale-gap counterfactual export", () => {
  it("exports the complete stored payload as NDJSON without local capture files", async () => {
    const source = await readFile(
      join(process.cwd(), "scripts/export-stale-gap-counterfactuals.ts"),
      "utf8",
    );
    assert.match(source, /staleGapCounterfactualCaptures/);
    assert.match(source, /select\(\{ payload: staleGapCounterfactualCaptures\.payload \}\)/);
    assert.match(source, /JSON\.stringify\(row\.payload\)/);
    assert.doesNotMatch(source, /stale-gap-counterfactual.*ndjson/);
    assert.doesNotMatch(source, /node:fs/);
  });
});