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
  trackedActives: [
    { plan: "Oconee", price: 409990, position: "Interior" },
    { plan: "Oconee", price: 409990, position: "Interior" },
    { plan: "Forsyth", price: 429990, position: "Standard" },
    { plan: "Forsyth", price: 460430, position: "Premium" },
    { plan: "Oconee", price: 463990, position: "End unit / premium" }
  ],
  documentedSales: [
    { plan: "Oconee", price: 399990 },
    { plan: "Oconee", price: 399990 },
    { plan: "Oconee", price: 399990 },
    { plan: "Reynolds", price: 435000 },
    { plan: "Reynolds", price: 450000 }
  ],
  competition: [
    { community: "Chandler Run", builder: "Taylor Morrison", low: 409990, high: 463990, tier: "Subject" },
    { community: "Fern Parc", builder: "Richardson Housing Group", low: 409950, high: 439950, tier: "Direct" },
    { community: "Walton Townes", builder: "Crawford Creek", low: 460000, high: 479550, tier: "Direct" },
    { community: "Trinity Park", builder: "Lennar-built resale", low: 449900, high: 449900, tier: "Secondary" },
    { community: "Rosewood Farm", builder: "Taylor Morrison", low: 349990, high: 437990, tier: "Secondary" },
    { community: "Towns at Creekside", builder: "Lennar", low: 450900, high: 473900, tier: "Benchmark" },
    { community: "Waterside", builder: "The Providence Group", low: 625900, high: 625900, tier: "Upper benchmark" },
    { community: "The Views from Browning", builder: "JW Collection", low: 700000, high: 700000, tier: "Upper benchmark" }
  ],
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
