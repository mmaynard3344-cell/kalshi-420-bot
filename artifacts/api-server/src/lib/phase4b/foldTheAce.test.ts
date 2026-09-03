import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  FOLD_THE_ACE_EROSION_THRESHOLD_FRACTION,
  classifyFoldTheAce,
  matchFoldTheAce,
  selectFoldTheAceRepresentatives,
  type FoldTheAceCandidate,
} from "./foldTheAce.js";

const candidate = (overrides: Partial<FoldTheAceCandidate> = {}): FoldTheAceCandidate => ({
  snapshotId: "s", observationKind: "baseline", marketId: "m", asset: "BTC", side: "yes", capturedAtMs: 1_000_000,
  secondsLeft: 60, selectedEntryPriceCents: 93, selectedSpreadCents: 2,
  threshold: 100, comparisonOperator: ">=", referencePrice: 105, referenceSourceTimestampMs: 1_000_000,
  anchor30Price: 100, anchor30SourceTimestampMs: 970_000, ...overrides,
});

describe("Fold the Ace preregistration", () => {
  it("uses the frozen H1 threshold and zero-movement handling for YES and NO", () => {
    const yes = classifyFoldTheAce(candidate({ referencePrice: 102, anchor30Price: 100 }));
    assert.equal(yes.signedCushionDollars, 2);
    assert.equal(yes.cushionOverMovement30s, 1);
    assert.equal(yes.h1, "unexposed");
    const no = classifyFoldTheAce(candidate({ side: "no", referencePrice: 102, anchor30Price: 100 }));
    assert.equal(no.signedCushionDollars, -2);
    assert.equal(no.h1, "exposed");
    const flat = classifyFoldTheAce(candidate({ referencePrice: 105, anchor30Price: 105 }));
    assert.equal(flat.cushionOverMovement30s, null);
    assert.equal(flat.h1, "unexposed");
  });

  it("uses the frozen five-basis-point H2 erosion rule and rejects invalid anchors", () => {
    const exposed = classifyFoldTheAce(candidate({ referencePrice: 100.4, anchor30Price: 101 }));
    assert.equal(exposed.h2, "exposed");
    assert.ok(exposed.selectedSideCushionChange30sDollars! <= -FOLD_THE_ACE_EROSION_THRESHOLD_FRACTION * 100);
    const flat = classifyFoldTheAce(candidate({ referencePrice: 100.96, anchor30Price: 101 }));
    assert.equal(flat.h2, "unexposed");
    const tooOld = classifyFoldTheAce(candidate({ anchor30SourceTimestampMs: 964_999 }));
    assert.equal(tooOld.h1, "unavailable");
    assert.equal(tooOld.h2, "unavailable");
  });

  it("keeps the earliest eligible baseline even when it lacks later-quality evidence", () => {
    const early = candidate({ snapshotId: "early", anchor30Price: null, anchor30SourceTimestampMs: null });
    const later = candidate({ snapshotId: "later", capturedAtMs: 1_005_000 });
    const selected = selectFoldTheAceRepresentatives([later, early]);
    assert.deepEqual(selected.map((item) => item.snapshotId), ["early"]);
  });

  it("never lets an event snapshot displace the scheduled baseline representative", () => {
    const earlierEvent = candidate({ snapshotId: "event", observationKind: "event", capturedAtMs: 995_000 });
    const baseline = candidate({ snapshotId: "baseline", capturedAtMs: 1_000_000 });
    assert.deepEqual(selectFoldTheAceRepresentatives([baseline, earlierEvent]).map((item) => item.snapshotId), ["baseline"]);
  });

  it("matches outcome-blind controls with the frozen tolerances and deterministic tie breaking", () => {
    const exposed = candidate({ snapshotId: "exposed", referencePrice: 100.5, anchor30Price: 101 });
    const closest = candidate({ snapshotId: "control-a", marketId: "c1", capturedAtMs: 1_001_000, referencePrice: 105, anchor30Price: 100 });
    const later = candidate({ snapshotId: "control-b", marketId: "c2", capturedAtMs: 1_002_000, referencePrice: 105, anchor30Price: 100 });
    const wrongSpread = candidate({ snapshotId: "wrong-spread", marketId: "c3", selectedSpreadCents: 3, referencePrice: 105, anchor30Price: 100 });
    const matches = matchFoldTheAce([exposed, later, wrongSpread, closest], "H2");
    assert.deepEqual(matches, [{ exposedSnapshotId: "exposed", controlSnapshotId: "control-a", hypothesis: "H2" }]);
  });

  it("requires an actual shared spread bucket and applies the Eastern calendar across DST", () => {
    const exposed = candidate({ snapshotId: "exposed", referencePrice: 100.5, anchor30Price: 101 });
    const noSpread = candidate({
      snapshotId: "no-spread", marketId: "c1", selectedSpreadCents: null, referencePrice: 105, anchor30Price: 100,
    });
    assert.deepEqual(matchFoldTheAce([exposed, noSpread], "H2"), []);

    const capturedAtMs = Date.parse("2026-03-07T23:30:00-05:00");
    const dstExposed = candidate({
      snapshotId: "dst-exposed", marketId: "dst-e", capturedAtMs, referencePrice: 100.5, anchor30Price: 101,
      referenceSourceTimestampMs: capturedAtMs, anchor30SourceTimestampMs: capturedAtMs - 30_000,
    });
    const controlAtMs = Date.parse("2026-03-15T00:15:00-04:00");
    const dstControl = candidate({
      snapshotId: "dst-control", marketId: "dst-c", capturedAtMs: controlAtMs, referencePrice: 105, anchor30Price: 100,
      referenceSourceTimestampMs: controlAtMs, anchor30SourceTimestampMs: controlAtMs - 30_000,
    });
    assert.ok(Math.abs(dstExposed.capturedAtMs - dstControl.capturedAtMs) < 7 * 24 * 60 * 60_000);
    assert.deepEqual(matchFoldTheAce([dstExposed, dstControl], "H2"), []);
  });

  it("does not import outcomes, storage, order, auth, route, or submission modules", () => {
    const source = readFileSync(join(process.cwd(), "src/lib/phase4b/foldTheAce.ts"), "utf8");
    assert.doesNotMatch(source, /from\s+["'][^"']*(outcome|settlement|tradeStore|order|auth|routes|submit|placeOrder)[^"']*["']/i);
  });
});