import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3000);

const dashboardData = {
  asOf: "2026-10-04",
  community: "Chandler Run",
  location: "Gwinnett County, Georgia",
  builder: "Taylor Morrison",
  objective: {
    label: "October net contract goal",
    target: 10,
    weeklyTarget: 3
  },
  market: {
    contractsYoY: -27.3,
    activeListingsYoY: 14.9,
    note: "Gwinnett September market pressure"
  },
  plans: [
    { plan: "Oconee", sqft: 1893 },
    { plan: "Forsyth", sqft: 1967 },
    { plan: "Reynolds", sqft: 2375 }
  ],
  trackedActives: [
    { plan: "Oconee", sqft: 1893, price: 409990, position: "Interior" },
    { plan: "Oconee", sqft: 1893, price: 409990, position: "Interior" },
    { plan: "Forsyth", sqft: 1967, price: 429990, position: "Standard" },
    { plan: "Forsyth", sqft: 1967, price: 460430, position: "Premium" },
    { plan: "Oconee", sqft: 1893, price: 463990, position: "End unit / premium" }
  ],
  documentedSales: [
    { plan: "Oconee", price: 399990 },
    { plan: "Oconee", price: 399990 },
    { plan: "Oconee", price: 399990 },
    { plan: "Reynolds", price: 435000 },
    { plan: "Reynolds", price: 450000 }
  ],
  competition: [
    { community: "Chandler Run", builder: "Taylor Morrison", low: 409990, high: 463990, sqftLow: 1893, sqftHigh: 2375, tier: "Subject" },
    { community: "Fern Parc", builder: "Richardson Housing Group", low: 409950, high: 439950, sqftLow: 1909, sqftHigh: 1918, tier: "Direct" },
    { community: "Walton Townes", builder: "Crawford Creek", low: 460000, high: 479550, sqftLow: 1696, sqftHigh: 1726, tier: "Direct" },
    { community: "Trinity Park", builder: "Lennar-built resale", low: 449900, high: 449900, sqftLow: 2001, sqftHigh: 2194, tier: "Secondary" },
    { community: "Rosewood Farm", builder: "Taylor Morrison", low: 349990, high: 437990, sqftLow: 1967, sqftHigh: 2375, tier: "Secondary" },
    { community: "Towns at Creekside", builder: "Lennar", low: 450900, high: 473900, sqftLow: null, sqftHigh: null, tier: "Benchmark" },
    { community: "Waterside", builder: "The Providence Group", low: 625900, high: 625900, sqftLow: 2162, sqftHigh: 2162, tier: "Upper benchmark" },
    { community: "The Views from Browning", builder: "JW Collection", low: 700000, high: 700000, sqftLow: 3400, sqftHigh: 3600, tier: "Upper benchmark" }
  ],
  absorption: {
    county: [
      { period: "Aug 2026", active: 3550, closings: 759, monthsSupplyProxy: 4.68 },
      { period: "Sep 2026", active: 3597, closings: 640, monthsSupplyProxy: 5.62 }
    ],
    trackedInventoryClearance: [
      { horizonDays: 30, requiredMonthlySales: 5.0 },
      { horizonDays: 60, requiredMonthlySales: 2.5 },
      { horizonDays: 90, requiredMonthlySales: 1.67 }
    ],
    note: "County figures are a rough active-listings / monthly-closings proxy, not townhome-only months of supply. Chandler Run community absorption cannot be measured reliably until total contractable inventory and recent net sales are verified."
  },
  pricingTests: [
    { segment: "Oconee interior", current: 409990, test: 399990, action: "Lead price / traffic generator" },
    { segment: "Forsyth standard", current: 429990, test: 409990, action: "Core October test" },
    { segment: "Premium Oconee / Forsyth", current: 463990, test: 419990, action: "Aggressive conversion test" },
    { segment: "Future Reynolds", current: null, test: 439990, action: "Suggested release anchor" }
  ],
  incentive: {
    budgetPerHome: 10000,
    description: "Up to $10,000 per home for closing-cost or rate assistance where needed."
  },
  caution: "Tracked public-MLS inventory only. Builder and portal totals have conflicted, so this is not a complete inventory count."
};

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "chandler-run-dashboard" }));
      return;
    }
    if (req.url === "/api/dashboard") {
      res.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store"
      });
      res.end(JSON.stringify(dashboardData));
      return;
    }
    if (req.url === "/" || req.url === "/index.html") {
      const html = await readFile(join(__dirname, "public", "index.html"));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
  } catch (error) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Internal server error" }));
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Chandler Run dashboard listening on :${port}`);
});
