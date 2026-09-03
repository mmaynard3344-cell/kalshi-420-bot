/**
 * tierLabel.consistency.test.ts
 *
 * Pure unit test — no database required.
 *
 * Guards the consistency between two representations of the same tier
 * boundary logic:
 *
 *   1. tierLabel(priceCents)  — stamps every passive observation at
 *      record-time (autoTraderGuards.ts).
 *
 *   2. buildTierSqlCaseString()  — builds the SQL CASE expression used by
 *      getVerifiedPnlByTier in tradeStore.ts to classify fills at query-time.
 *      getVerifiedPnlByTier calls this function directly (it was refactored to
 *      do so as part of this task), so any change to the SQL builder is
 *      automatically exercised here.
 *
 * If the two diverge (boundary typo, off-by-one on >= vs >, copy-paste drift,
 * or a future refactor that edits only one side) fill records will appear in a
 * different tier on the P&L report than in the observation history.
 *
 * Test strategy:
 *   - Call buildTierSqlCaseString() to get the production SQL CASE string.
 *   - Parse it with a regex to extract every (min, max, label) triple.
 *   - Assert the parsed triples match PRICE_TIERS exactly (structural check).
 *   - Assert that evaluating the parsed SQL logic for each boundary price
 *     gives the same result as tierLabel() (semantic check).
 *
 * Boundary coverage per tier:
 *   • price === tier.min  → named tier label  (inclusive min)
 *   • price === tier.max  → named tier label  (inclusive max)
 *   • price === tier.min - 1  → outside this tier
 *   • price === tier.max + 1  → outside this tier
 *
 * Run via:
 *   pnpm --filter @workspace/api-server test  (included in run-all-tests.mjs)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PRICE_TIERS, tierLabel, buildTierSqlCaseString } from "./autoTraderGuards.js";

// ---------------------------------------------------------------------------
// Parse the SQL CASE string produced by the production builder.
//
// buildTierSqlCaseString() emits a string of the form:
//   CASE WHEN <col> >= <min> AND <col> <= <max> THEN '<label>' ... ELSE 'other' END
//
// The regex matches each WHEN clause and extracts the numeric bounds and label.
// Using the production string (rather than a hand-written copy) means any
// edit to the SQL template in autoTraderGuards.ts is reflected here directly.
// ---------------------------------------------------------------------------

interface ParsedTierClause {
  min: number;
  max: number;
  label: string;
}

function parseSqlCaseClauses(caseExpr: string): ParsedTierClause[] {
  const clauses: ParsedTierClause[] = [];
  // Matches: WHEN <word> >= <digits> AND <word> <= <digits> THEN '<label>'
  const pattern = /WHEN \w+ >= (\d+) AND \w+ <= (\d+) THEN '([^']+)'/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(caseExpr)) !== null) {
    clauses.push({
      min:   parseInt(match[1]!, 10),
      max:   parseInt(match[2]!, 10),
      label: match[3]!,
    });
  }
  return clauses;
}

/**
 * Evaluate the parsed SQL CASE clauses for a price (mimics the DB engine).
 * Iterates in order — identical to the SQL CASE evaluation semantics.
 */
function evalParsedClauses(clauses: ParsedTierClause[], priceCents: number): string {
  for (const c of clauses) {
    if (priceCents >= c.min && priceCents <= c.max) return c.label;
  }
  return "other";
}

// ---------------------------------------------------------------------------
// Build the production SQL string once and parse it.  Every test below
// works from this single production artifact.
// ---------------------------------------------------------------------------
const productionSqlCase = buildTierSqlCaseString();
const parsedClauses     = parseSqlCaseClauses(productionSqlCase);

describe("tierLabel / getVerifiedPnlByTier consistency", () => {

  // ── Sanity: ensure the production SQL was parseable ─────────────────────
  it("buildTierSqlCaseString() produces a non-empty CASE expression", () => {
    assert.ok(
      productionSqlCase.startsWith("CASE ") && productionSqlCase.endsWith(" END"),
      `Expected 'CASE ... END', got: ${productionSqlCase}`,
    );
  });

  it("PRICE_TIERS is non-empty", () => {
    assert.ok(PRICE_TIERS.length > 0, "PRICE_TIERS must contain at least one tier");
  });

  it("parseSqlCaseClauses extracts the same number of clauses as PRICE_TIERS entries", () => {
    assert.equal(
      parsedClauses.length,
      PRICE_TIERS.length,
      `SQL CASE has ${parsedClauses.length} WHEN clause(s) but PRICE_TIERS has ${PRICE_TIERS.length} — mismatch`,
    );
  });

  // ── Structural: parsed SQL boundaries match PRICE_TIERS exactly ──────────
  //
  // This catches: a typo in the SQL template (e.g. wrong literal), a
  // boundary number altered in one place but not the other, or a tier
  // silently dropped / reordered in the CASE string.
  for (let i = 0; i < PRICE_TIERS.length; i++) {
    const tier = PRICE_TIERS[i]!;
    it(`SQL CASE clause ${i} boundaries match PRICE_TIERS[${i}] ('${tier.label}')`, () => {
      const clause = parsedClauses[i];
      assert.ok(
        clause !== undefined,
        `No SQL CASE clause found at index ${i} — parsedClauses has only ${parsedClauses.length} entries`,
      );
      assert.equal(
        clause.min,
        tier.min,
        `SQL CASE clause ${i} min = ${clause.min}, expected ${tier.min} from PRICE_TIERS`,
      );
      assert.equal(
        clause.max,
        tier.max,
        `SQL CASE clause ${i} max = ${clause.max}, expected ${tier.max} from PRICE_TIERS`,
      );
      assert.equal(
        clause.label,
        tier.label,
        `SQL CASE clause ${i} label = '${clause.label}', expected '${tier.label}' from PRICE_TIERS`,
      );
    });
  }

  // ── Semantic: tierLabel() and the production SQL agree on every boundary ─
  //
  // These are the critical runtime checks: for any price that touches a tier
  // boundary, the observation stamp and the P&L query must classify it
  // identically.
  for (const tier of PRICE_TIERS) {

    it(`price at tier min (${tier.min}¢): tierLabel and SQL CASE both return '${tier.label}'`, () => {
      const fromGuard = tierLabel(tier.min);
      const fromSql   = evalParsedClauses(parsedClauses, tier.min);
      assert.equal(fromGuard, tier.label,  `tierLabel(${tier.min}) → '${fromGuard}', expected '${tier.label}'`);
      assert.equal(fromSql,   tier.label,  `SQL CASE(${tier.min}) → '${fromSql}', expected '${tier.label}'`);
      assert.equal(fromGuard, fromSql,     `tierLabel and SQL CASE disagree at ${tier.min}¢`);
    });

    it(`price at tier max (${tier.max}¢): tierLabel and SQL CASE both return '${tier.label}'`, () => {
      const fromGuard = tierLabel(tier.max);
      const fromSql   = evalParsedClauses(parsedClauses, tier.max);
      assert.equal(fromGuard, tier.label,  `tierLabel(${tier.max}) → '${fromGuard}', expected '${tier.label}'`);
      assert.equal(fromSql,   tier.label,  `SQL CASE(${tier.max}) → '${fromSql}', expected '${tier.label}'`);
      assert.equal(fromGuard, fromSql,     `tierLabel and SQL CASE disagree at ${tier.max}¢`);
    });

    it(`price just below tier min (${tier.min - 1}¢): tierLabel and SQL CASE agree, not in '${tier.label}'`, () => {
      const fromGuard = tierLabel(tier.min - 1);
      const fromSql   = evalParsedClauses(parsedClauses, tier.min - 1);
      assert.equal(
        fromGuard,
        fromSql,
        `tierLabel(${tier.min - 1}) = '${fromGuard}' but SQL CASE = '${fromSql}' — implementations disagree`,
      );
      assert.notEqual(
        fromGuard,
        tier.label,
        `price ${tier.min - 1}¢ is below tier min but both returned '${tier.label}'`,
      );
    });

    it(`price just above tier max (${tier.max + 1}¢): tierLabel and SQL CASE agree, not in '${tier.label}'`, () => {
      const fromGuard = tierLabel(tier.max + 1);
      const fromSql   = evalParsedClauses(parsedClauses, tier.max + 1);
      assert.equal(
        fromGuard,
        fromSql,
        `tierLabel(${tier.max + 1}) = '${fromGuard}' but SQL CASE = '${fromSql}' — implementations disagree`,
      );
      assert.notEqual(
        fromGuard,
        tier.label,
        `price ${tier.max + 1}¢ is above tier max but both returned '${tier.label}'`,
      );
    });
  }

  // ── Prices outside every tier → both return "other" ──────────────────────
  it("price 0¢ → both return 'other'", () => {
    assert.equal(tierLabel(0),                        "other");
    assert.equal(evalParsedClauses(parsedClauses, 0), "other");
  });

  it("price 100¢ → both return 'other'", () => {
    assert.equal(tierLabel(100),                        "other");
    assert.equal(evalParsedClauses(parsedClauses, 100), "other");
  });

  it("price 50¢ → both return 'other' (mid-range, no tier covers this)", () => {
    assert.equal(tierLabel(50),                        "other");
    assert.equal(evalParsedClauses(parsedClauses, 50), "other");
  });

  // ── Structural invariants on PRICE_TIERS itself ───────────────────────────
  it("each PRICE_TIERS entry has min ≤ max", () => {
    for (const tier of PRICE_TIERS) {
      assert.ok(
        tier.min <= tier.max,
        `Tier '${tier.label}' has min (${tier.min}) > max (${tier.max})`,
      );
    }
  });

  it("all PRICE_TIERS labels are unique", () => {
    const labels = PRICE_TIERS.map((t) => t.label);
    const unique = new Set(labels);
    assert.equal(
      unique.size,
      labels.length,
      `Duplicate tier labels: ${labels.filter((l, i) => labels.indexOf(l) !== i).join(", ")}`,
    );
  });
});
