import fs from 'node:fs';

const path = new URL('../src/routes/trade.ts', import.meta.url);
let source = fs.readFileSync(path, 'utf8');

const oldOrders = `/** GET /trade/orders?limit= — recent orders. */\nrouter.get("/trade/orders", requireTradeAuth, async (req, res) => {\n  try {\n    const limit = Math.min(Number(req.query["limit"] ?? 25), 100);\n    const qs = new URLSearchParams({ limit: String(limit) });\n    const data = await kalshiAuthFetch<{ orders?: unknown[] }>("GET", \`/portfolio/orders?\${qs}\`);\n    res.json(data);\n  } catch (err: unknown) {`;

const newOrders = `/** GET /trade/orders?limit=&cursor= — read-only paginated exchange orders. */\nrouter.get("/trade/orders", requireTradeAuth, async (req, res) => {\n  try {\n    const requested = Number(req.query["limit"] ?? 25);\n    const limit = Math.max(1, Math.min(Number.isFinite(requested) ? Math.trunc(requested) : 25, 1_000));\n    const orders: unknown[] = [];\n    let cursor = typeof req.query["cursor"] === "string" && req.query["cursor"] ? req.query["cursor"] : undefined;\n    while (orders.length < limit) {\n      const pageLimit = Math.min(100, limit - orders.length);\n      const qs = new URLSearchParams({ limit: String(pageLimit) });\n      if (cursor) qs.set("cursor", cursor);\n      const page = await kalshiAuthFetch<{ orders?: unknown[]; cursor?: string }>("GET", \`/portfolio/orders?\${qs}\`);\n      const pageOrders = page.orders ?? [];\n      orders.push(...pageOrders);\n      if (pageOrders.length < pageLimit || !page.cursor) { cursor = undefined; break; }\n      cursor = page.cursor;\n    }\n    res.json({ orders, ...(cursor ? { cursor } : {}) });\n  } catch (err: unknown) {`;

if (source.includes(oldOrders)) source = source.replace(oldOrders, newOrders);
else if (!source.includes('read-only paginated exchange orders')) throw new Error('orders pagination anchor not found');

const oldFillStart = `    const limit = Math.min(Number(req.query["limit"] ?? 100), 1_000);\n\n    // Cached per requested limit through the shared quota-aware read path:`;
const newFillStart = `    const requested = Number(req.query["limit"] ?? 100);\n    const limit = Math.max(1, Math.min(Number.isFinite(requested) ? Math.trunc(requested) : 100, 1_000));\n    const startCursor = typeof req.query["cursor"] === "string" && req.query["cursor"] ? req.query["cursor"] : undefined;\n\n    // Cached per requested limit/cursor through the shared quota-aware read path:`;
if (source.includes(oldFillStart)) source = source.replace(oldFillStart, newFillStart);
else if (!source.includes('const startCursor = typeof req.query["cursor"]')) throw new Error('fills start cursor anchor not found');

const oldCache = `    const read = await sharedFillsViewCache.get(\`limit=\${limit}\`, async () => {`;
const newCache = `    const read = await sharedFillsViewCache.get(\`limit=\${limit};cursor=\${startCursor ?? ''}\`, async () => {`;
if (source.includes(oldCache)) source = source.replace(oldCache, newCache);
else if (!source.includes("cursor=${startCursor ?? ''}")) throw new Error('fills cache-key anchor not found');

const oldCursor = `      let cursor: string | undefined;`;
const newCursor = `      let cursor: string | undefined = startCursor;`;
if (source.includes(oldCursor)) source = source.replace(oldCursor, newCursor);
else if (!source.includes('let cursor: string | undefined = startCursor;')) throw new Error('fills cursor anchor not found');

const oldReturn = `      return fills.map((f) => ({\n        ...f,\n        market_result: resultMap[f.ticker] ?? "",\n      }));\n    });\n\n    res.json({ fills: read.value, stale: read.stale });`;
const newReturn = `      return {\n        fills: fills.map((f) => ({\n          ...f,\n          market_result: resultMap[f.ticker] ?? "",\n        })),\n        cursor,\n      };\n    });\n\n    res.json({ fills: read.value.fills, ...(read.value.cursor ? { cursor: read.value.cursor } : {}), stale: read.stale });`;
if (source.includes(oldReturn)) source = source.replace(oldReturn, newReturn);
else if (!source.includes('fills: read.value.fills')) throw new Error('fills response cursor anchor not found');

for (const proof of [
  'read-only paginated exchange orders',
  'let cursor: string | undefined = startCursor;',
  'fills: read.value.fills',
]) {
  if (!source.includes(proof)) throw new Error(`pagination proof missing: ${proof}`);
}

fs.writeFileSync(path, source);
console.log('Applied read-only historical order/fill pagination for dashboard reconciliation');
