/**
 * Unit tests for the data-derivation logic inside EntryGapCoveragePanel.
 *
 * The panel reads `data.rows` and `data.backfillRows` from the server response.
 * Older server versions (pre-backfill) may return only a `summary` object and
 * omit `rows` / `backfillRows` entirely.  `deriveEntryGapPanelState` (the real
 * production function used by EntryGapCoveragePanel) guards with `?? []` / `?? 0`
 * fallbacks; these tests exercise the actual helper to confirm the fallbacks hold.
 *
 * Run via the api-server esbuild harness (same pattern as alertReset.test.ts):
 *   cd artifacts/api-server && \
 *   node_modules/.bin/esbuild \
 *     ../kalshi-reader/src/pages/Dashboard.entryGap.test.ts \
 *     --bundle --platform=node --format=esm \
 *     --outfile=/tmp/entry-gap.mjs && \
 *   node --test /tmp/entry-gap.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Import the real production helper — the same function EntryGapCoveragePanel calls.
import {
  deriveEntryGapPanelState,
  type EntryGapApiResponse,
  type EntryGapRow,
  type EntryGapBackfillRow,
} from '../lib/entryGapPanel.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function baseSummary(overrides: Partial<EntryGapApiResponse['summary']> = {}): EntryGapApiResponse['summary'] {
  return {
    inBandTotal: 0,
    measurable: 0,
    unavailable: 0,
    evidenceStatusCounts: {},
    ...overrides,
  };
}

function makeRow(snapshotId: string): EntryGapRow {
  return {
    snapshotId,
    ticker: 'KXBTC15M-26-T1',
    side: 'yes',
    entryPriceCents: 92,
    secondsLeft: 45,
    capturedAtMs: 1_700_000_000_000,
    thresholdStrike: 90000,
    comparisonOperator: 'gte',
    causalReferencePrice: 89500,
    causalReferenceSourceTimestampMs: 1_700_000_000_000 - 5000,
    causalReferenceAgeMs: 5000,
    causalEvidenceStatus: 'live',
    signedGapDollars: -500,
    absoluteGapDollars: 500,
    referenceVsTarget: 'below_target',
    qualification: 'in_band_measurable',
    unavailableReasons: [],
  };
}

function makeBackfillRow(snapshotId: string): EntryGapBackfillRow {
  return { ...makeRow(snapshotId), backfillSource: 'phase4b_reference_observations' };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('deriveEntryGapPanelState — legacy response shapes', () => {

  describe('summary-only response (rows and backfillRows both absent)', () => {
    // Pre-backfill servers return only summary; rows/backfillRows are undefined.
    const data: EntryGapApiResponse = {
      hypothesisVersion: 'entry-gap-90-95-v1',
      summary: baseSummary(),
      // rows and backfillRows intentionally omitted
    };

    it('does not throw when rows is undefined', () => {
      assert.doesNotThrow(() => deriveEntryGapPanelState(data));
    });

    it('liveCount is 0', () => {
      assert.equal(deriveEntryGapPanelState(data).liveCount, 0);
    });

    it('backfillCount is 0', () => {
      assert.equal(deriveEntryGapPanelState(data).backfillCount, 0);
    });

    it('liveRows is an empty array', () => {
      assert.deepEqual(deriveEntryGapPanelState(data).liveRows, []);
    });

    it('backfillRows is an empty array', () => {
      assert.deepEqual(deriveEntryGapPanelState(data).backfillRows, []);
    });

    it('noData is true', () => {
      assert.equal(deriveEntryGapPanelState(data).noData, true);
    });

    it('allMeasurable is false (no data)', () => {
      assert.equal(deriveEntryGapPanelState(data).allMeasurable, false);
    });

    it('statusEntries is empty', () => {
      assert.deepEqual(deriveEntryGapPanelState(data).statusEntries, []);
    });
  });

  describe('rows present but backfillRows absent (pre-backfill server)', () => {
    const liveRow = makeRow('snap-001');
    const data: EntryGapApiResponse = {
      hypothesisVersion: 'entry-gap-90-95-v1',
      summary: baseSummary({
        inBandTotal: 1,
        measurable: 1,
        unavailable: 0,
        liveCount: 1,
        // backfillCount intentionally absent to simulate older server
        evidenceStatusCounts: { live: 1 },
      }),
      rows: [liveRow],
      // backfillRows intentionally omitted
    };

    it('does not throw', () => {
      assert.doesNotThrow(() => deriveEntryGapPanelState(data));
    });

    it('liveCount equals the summary liveCount', () => {
      assert.equal(deriveEntryGapPanelState(data).liveCount, 1);
    });

    it('backfillCount falls back to 0 when backfillRows is absent', () => {
      assert.equal(deriveEntryGapPanelState(data).backfillCount, 0);
    });

    it('liveRows contains the expected row', () => {
      const { liveRows } = deriveEntryGapPanelState(data);
      assert.equal(liveRows.length, 1);
      assert.equal(liveRows[0]!.snapshotId, 'snap-001');
    });

    it('backfillRows is an empty array', () => {
      assert.deepEqual(deriveEntryGapPanelState(data).backfillRows, []);
    });

    it('noData is false (there is a live row)', () => {
      assert.equal(deriveEntryGapPanelState(data).noData, false);
    });
  });

  describe('both rows and backfillRows absent AND summary counts also absent', () => {
    // Very old server: no rows arrays, no liveCount/backfillCount in summary.
    const data: EntryGapApiResponse = {
      hypothesisVersion: 'entry-gap-90-95-v1',
      summary: {
        inBandTotal: 0,
        measurable: 0,
        unavailable: 0,
        evidenceStatusCounts: {},
        // liveCount and backfillCount intentionally absent
      },
    };

    it('does not throw', () => {
      assert.doesNotThrow(() => deriveEntryGapPanelState(data));
    });

    it('liveCount is 0', () => {
      assert.equal(deriveEntryGapPanelState(data).liveCount, 0);
    });

    it('backfillCount is 0', () => {
      assert.equal(deriveEntryGapPanelState(data).backfillCount, 0);
    });

    it('liveRows is []', () => {
      assert.deepEqual(deriveEntryGapPanelState(data).liveRows, []);
    });

    it('backfillRows is []', () => {
      assert.deepEqual(deriveEntryGapPanelState(data).backfillRows, []);
    });
  });

  describe('full modern response (rows + backfillRows both present)', () => {
    const liveRow = makeRow('snap-live-1');
    const bfRow   = makeBackfillRow('snap-bf-1');
    const data: EntryGapApiResponse = {
      hypothesisVersion: 'entry-gap-90-95-v1',
      summary: baseSummary({
        inBandTotal: 2,
        measurable: 2,
        unavailable: 0,
        liveCount: 1,
        backfillCount: 1,
        evidenceStatusCounts: { live: 2 },
      }),
      rows: [liveRow],
      backfillRows: [bfRow],
    };

    it('does not throw', () => {
      assert.doesNotThrow(() => deriveEntryGapPanelState(data));
    });

    it('liveCount is 1', () => {
      assert.equal(deriveEntryGapPanelState(data).liveCount, 1);
    });

    it('backfillCount is 1', () => {
      assert.equal(deriveEntryGapPanelState(data).backfillCount, 1);
    });

    it('liveRows contains the live row', () => {
      const { liveRows } = deriveEntryGapPanelState(data);
      assert.equal(liveRows.length, 1);
      assert.equal(liveRows[0]!.snapshotId, 'snap-live-1');
    });

    it('backfillRows contains the backfill row', () => {
      const { backfillRows } = deriveEntryGapPanelState(data);
      assert.equal(backfillRows.length, 1);
      assert.equal(backfillRows[0]!.snapshotId, 'snap-bf-1');
    });

    it('allMeasurable is true (unavailable=0 and inBandTotal>0)', () => {
      assert.equal(deriveEntryGapPanelState(data).allMeasurable, true);
    });

    it('noData is false', () => {
      assert.equal(deriveEntryGapPanelState(data).noData, false);
    });
  });

  describe('liveCount / backfillCount fall back to array length when summary omits them', () => {
    // Server provides rows arrays but omits the explicit count fields.
    const data: EntryGapApiResponse = {
      hypothesisVersion: 'entry-gap-90-95-v1',
      summary: baseSummary({
        inBandTotal: 3,
        measurable: 3,
        evidenceStatusCounts: { live: 3 },
        // liveCount and backfillCount intentionally absent
      }),
      rows: [makeRow('a'), makeRow('b')],
      backfillRows: [makeBackfillRow('c')],
    };

    it('liveCount falls back to rows.length (2)', () => {
      assert.equal(deriveEntryGapPanelState(data).liveCount, 2);
    });

    it('backfillCount falls back to backfillRows.length (1)', () => {
      assert.equal(deriveEntryGapPanelState(data).backfillCount, 1);
    });
  });
});
