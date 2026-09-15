import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const strategyPath = join(here, "..", "src", "lib", "strategies", "ethJackpotService.ts");
const researchPath = join(here, "..", "src", "lib", "strategies", "jackpotPreboundaryResearch.ts");
const testPath = join(here, "..", "src", "lib", "strategies", "ethJackpotService.test.ts");

function replaceExactlyOnce(source, from, to, label) {
  const hits = source.split(from).length - 1;
  if (hits === 0 && source.includes(to)) return source; // idempotent
  if (hits !== 1) throw new Error(`Jackpot repair expected exactly one ${label} anchor, found ${hits}`);
  return source.replace(from, to);
}

let strategy = readFileSync(strategyPath, "utf8");
strategy = replaceExactlyOnce(
  strategy,
  '`/portfolio/events/orders/${encodeURIComponent(order.kalshiOrderId)}`',
  '`/portfolio/orders/${encodeURIComponent(order.kalshiOrderId)}`',
  "V1 cancel endpoint",
);
strategy = replaceExactlyOnce(
  strategy,
  'kalshiAuthFetch<Record<string, unknown>>("POST", "/portfolio/events/orders", payload)',
  'kalshiAuthFetch<Record<string, unknown>>("POST", "/portfolio/orders", payload)',
  "V1 create endpoint",
);
if (strategy.includes("/portfolio/events/orders")) {
  throw new Error("Jackpot repair refused build: deprecated V1 order endpoint remains in ethJackpotService.ts");
}
strategy = replaceExactlyOnce(strategy, "async function cancelAAndProveZero(order: JackpotAOrder): Promise<Record<string, unknown> | null> {\n  try {\n    await kalshiAuthFetch<Record<string, unknown>>(\n      \"DELETE\", `/portfolio/orders/${encodeURIComponent(order.kalshiOrderId)}`,\n    );\n  } catch (err) {\n    logger.warn({ err, ticker: order.ticker, aOrderId: order.id }, \"Jackpot A cancel request failed\");\n    return null;\n  }\n  for (const delay of [0, 75, 200, 500]) {\n    if (delay) await new Promise((r) => setTimeout(r, delay));\n    try {\n      const raw = await getAExchangeOrder(order);\n      const parsed = parseKalshiOrderResponse(raw, order.requestedContracts);\n      if (parsed.fillCountProvided && parsed.fillCount > 0) return null;\n      if (terminalZeroFill(raw, order.requestedContracts)) return raw;\n    } catch {\n      // Fail closed and retry the exact authenticated read only.\n    }\n  }\n  return null;\n}", "async function confirmAStillRestingZeroFill(order: JackpotAOrder): Promise<Record<string, unknown> | null> {\n  // J treats A as a read-only signal. It must never cancel, replace, or mutate A.\n  // A remains independently managed by Service A for its full resting lifecycle.\n  try {\n    const raw = await getAExchangeOrder(order);\n    const parsed = parseKalshiOrderResponse(raw, order.requestedContracts);\n    const stillResting = parsed.orderStatus === \"resting\" || parsed.orderStatus === \"open\";\n    return parsed.fillCountProvided && parsed.fillCount === 0 && stillResting ? raw : null;\n  } catch (err) {\n    logger.warn({ err, ticker: order.ticker, aOrderId: order.id }, \"Jackpot read-only A confirmation failed\");\n    return null;\n  }\n}", "A cancel helper");
strategy = replaceExactlyOnce(strategy, "  // Critical race fence: cancel A, then authenticate the exact order again. If\n  // even one A contract filled, J must not add exposure.\n  const canceled = await cancelAAndProveZero(order);\n  if (!canceled) {\n    await patchAttempt(order.id, { status: \"blocked\", reason: \"a_not_still_resting_zero_fill\" });\n    return;\n  }", "  // Read-only safety fence: verify A is still resting with authoritative zero\n  // fills, but never cancel, replace, or otherwise alter A's order.\n  const confirmed = await confirmAStillRestingZeroFill(order);\n  if (!confirmed) {\n    await patchAttempt(order.id, { status: \"blocked\", reason: \"a_not_still_resting_zero_fill\" });\n    return;\n  }", "A cancel flow");
if (strategy.includes("cancelAAndProveZero") || strategy.includes('"DELETE"')) {
  throw new Error("Jackpot repair refused build: J must not cancel or mutate A orders");
}
writeFileSync(strategyPath, strategy);

let research = readFileSync(researchPath, "utf8");
research = replaceExactlyOnce(
  research,
  'import { kalshiSeriesFetch } from "../kalshi.js";',
  'import { kalshiFetch, kalshiSeriesFetch } from "../kalshi.js";',
  "Kalshi import",
);

const helperAnchor = 'async function fetchFreshEthSpot(): Promise<{ eth: number; receiptMs: number } | null> {';
const helperBlock = `export function selectExactBoundaryMarket(\n  markets: Array<Record<string, unknown>>,\n  boundaryMs: number,\n): Record<string, unknown> | null {\n  if (!Number.isFinite(boundaryMs)) return null;\n  const matches = markets.filter((market) => {\n    const openTime = typeof market["open_time"] === "string" ? Date.parse(market["open_time"] as string) : NaN;\n    return Number.isFinite(openTime) && openTime === boundaryMs\n      && typeof market["ticker"] === "string"\n      && String(market["ticker"]).startsWith("KXETH15M-");\n  });\n  return matches.length === 1 ? matches[0]! : null;\n}\n\nasync function fetchExactBoundaryMarket(boundaryMs: number): Promise<Record<string, unknown> | null> {\n  // Kalshi may expose near-future ETH 15m markets as status=open before their\n  // official open_time. Query a broad fresh catalog and select ONLY the market\n  // whose open_time exactly equals this boundary; never substitute a farther row.\n  for (const status of ["open", "unopened"] as const) {\n    try {\n      const data = await kalshiFetch<{ markets?: Array<Record<string, unknown>> }>("/markets", {\n        series_ticker: "KXETH15M",\n        status,\n        limit: 100,\n      });\n      const exact = selectExactBoundaryMarket(data.markets ?? [], boundaryMs);\n      if (exact) return exact;\n    } catch {\n      // Try the other catalog state. Missing exact market remains fail-closed.\n    }\n  }\n  return null;\n}\n\n`;
if (!research.includes("export function selectExactBoundaryMarket(")) {
  if (!research.includes(helperAnchor)) throw new Error("Jackpot repair missing pre-boundary helper anchor");
  research = research.replace(helperAnchor, helperBlock + helperAnchor);
}
research = replaceExactlyOnce(
  research,
  'kalshiSeriesFetch("KXETH15M", { status: "unopened", forceFresh: true })',
  'fetchExactBoundaryMarket(boundaryMs)',
  "pre-boundary next-market discovery",
);
if (research.includes('kalshiSeriesFetch("KXETH15M", { status: "unopened", forceFresh: true })')) {
  throw new Error("Jackpot repair refused build: stale unopened-only discovery remains");
}
writeFileSync(researchPath, research);

let tests = readFileSync(testPath, "utf8");
const testImport = 'import { selectExactBoundaryMarket } from "./jackpotPreboundaryResearch.js";\n';
if (!tests.includes(testImport.trim())) {
  tests = tests.replace('import test from "node:test";\n', 'import test from "node:test";\n' + testImport);
}
const testBlock = `\ntest("Jackpot pre-boundary discovery selects only the exact next 15m boundary", () => {\n  const boundary = Date.parse("2026-09-14T22:30:00Z");\n  const markets = [\n    { ticker: "KXETH15M-FAR", open_time: "2026-09-14T23:15:00Z", floor_strike: 2600 },\n    { ticker: "KXETH15M-NEXT", open_time: "2026-09-14T22:30:00Z", floor_strike: 2550 },\n    { ticker: "KXETH15M-LATER", open_time: "2026-09-14T22:45:00Z", floor_strike: 2575 },\n  ];\n  assert.equal(selectExactBoundaryMarket(markets, boundary)?.ticker, "KXETH15M-NEXT");\n  assert.equal(selectExactBoundaryMarket(markets.filter((m) => m.ticker !== "KXETH15M-NEXT"), boundary), null,\n    "never substitutes a farther future market when the exact boundary is absent");\n});\n`;
if (!tests.includes('test("Jackpot pre-boundary discovery selects only the exact next 15m boundary"')) tests += testBlock;
writeFileSync(testPath, tests);

console.log("Applied Jackpot-only repair: V2 create endpoint + exact-boundary discovery + read-only A isolation");
