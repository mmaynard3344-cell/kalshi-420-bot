import fs from 'node:fs';

const serverPath = new URL('../server.mjs', import.meta.url);
let server = fs.readFileSync(serverPath, 'utf8');

const marker = 'async function databasePnlSummary(req, res) {';
if (!server.includes(marker)) {
  const anchor = 'function serveStatic(req, res, url) {';
  if (!server.includes(anchor)) throw new Error('database P&L server anchor not found');
  const block = `async function databasePnlSummary(req, res) {\n  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');\n  try {\n    const days = await withReadOnlyDb(async (client) => {\n      const result = await client.query(\`\n        WITH regular AS (\n          SELECT\n            eastern_date,\n            1::int AS settled,\n            CASE WHEN settlement_result = side THEN 1 ELSE 0 END::int AS wins,\n            CASE WHEN settlement_result <> side THEN 1 ELSE 0 END::int AS losses,\n            ROUND(COALESCE(actual_notional_dollars, 0) * 100)::bigint AS wagered_cents,\n            ROUND(COALESCE(actual_fee_dollars, 0) * 100)::bigint AS fees_cents,\n            CASE\n              WHEN settlement_result = side THEN\n                ROUND(COALESCE(filled_contracts, 0) * 100 - COALESCE(actual_notional_dollars, 0) * 100 - COALESCE(actual_fee_dollars, 0) * 100)::bigint\n              ELSE\n                ROUND(-COALESCE(actual_notional_dollars, 0) * 100 - COALESCE(actual_fee_dollars, 0) * 100)::bigint\n            END AS net_cents\n          FROM eth_martingale_orders\n          WHERE ticker LIKE 'KXETH15M-%'\n            AND eastern_date >= '2026-08-27'\n            AND settlement_result IN ('yes','no')\n            AND filled_contracts IS NOT NULL AND filled_contracts > 0\n            AND actual_notional_dollars IS NOT NULL\n        ),\n        candidate AS (\n          SELECT\n            eastern_date,\n            1::int AS settled,\n            CASE WHEN settlement_result = side THEN 1 ELSE 0 END::int AS wins,\n            CASE WHEN settlement_result <> side THEN 1 ELSE 0 END::int AS losses,\n            ROUND(COALESCE(NULLIF(actual_notional_dollars, '')::numeric, 0) * 100)::bigint AS wagered_cents,\n            ROUND(COALESCE(NULLIF(actual_fee_dollars, '')::numeric, 0) * 100)::bigint AS fees_cents,\n            realized_pnl_delta_cents::bigint AS net_cents\n          FROM eth420_candidate_live_orders\n          WHERE ticker LIKE 'KXETH15M-%'\n            AND eastern_date >= '2026-08-27'\n            AND status = 'settled'\n            AND settlement_result IN ('yes','no')\n            AND filled_contracts IS NOT NULL AND filled_contracts > 0\n            AND realized_pnl_delta_cents IS NOT NULL\n        ),\n        ledger AS (\n          SELECT * FROM regular\n          UNION ALL\n          SELECT * FROM candidate\n        )\n        SELECT\n          eastern_date,\n          SUM(settled)::int AS settled,\n          SUM(wins)::int AS wins,\n          SUM(losses)::int AS losses,\n          SUM(wagered_cents)::bigint AS wagered_cents,\n          SUM(fees_cents)::bigint AS fees_cents,\n          SUM(net_cents)::bigint AS net_cents\n        FROM ledger\n        GROUP BY eastern_date\n        ORDER BY eastern_date ASC\n      \`);\n      return result.rows;\n    });\n\n    const normalized = days.map((row) => ({\n      easternDate: String(row.eastern_date),\n      bets: Number(row.settled ?? 0),\n      settled: Number(row.settled ?? 0),\n      wins: Number(row.wins ?? 0),\n      losses: Number(row.losses ?? 0),\n      wageredCents: Number(row.wagered_cents ?? 0),\n      feesCents: Number(row.fees_cents ?? 0),\n      netCents: Number(row.net_cents ?? 0),\n    }));\n    const response = { available: true, generatedAtMs: Date.now(), method: 'durable_postgres_transaction_ledgers', days: normalized };\n    if (req.method === 'HEAD') return send(res, 200, '', 'application/json; charset=utf-8');\n    return send(res, 200, JSON.stringify(response), 'application/json; charset=utf-8');\n  } catch (error) {\n    console.error('Database P&L summary failed', error);\n    return send(res, 500, JSON.stringify({ available: false, error: String(error?.message ?? 'Database P&L summary failed') }), 'application/json; charset=utf-8');\n  }\n}\n\n`;
  server = server.replace(anchor, block + anchor);
}

const route = "  if (url.pathname === '/api/diagnostics/db-pnl') return void databasePnlSummary(req, res);";
if (!server.includes(route)) {
  const routeAnchor = "  if (url.pathname === '/api/diagnostics/back-flips') return void backFlipDiagnostics(req, res, false);";
  if (!server.includes(routeAnchor)) throw new Error('database P&L route anchor not found');
  server = server.replace(routeAnchor, routeAnchor + '\n' + route);
}
fs.writeFileSync(serverPath, server);

const pnlPath = new URL('../public/pnl-runtime.js', import.meta.url);
let pnl = fs.readFileSync(pnlPath, 'utf8');

// Original formatted runtime.
if (pnl.includes('const [fillResult, orderResult] = await Promise.allSettled([') || pnl.includes('const [fillResult, orderResult, dbPnlResult] = await Promise.allSettled([')) {
  if (!pnl.includes("fetch('/api/diagnostics/db-pnl'")) {
    pnl = pnl.replace(
      '      const [fillResult, orderResult] = await Promise.allSettled([',
      '      const [fillResult, orderResult, dbPnlResult] = await Promise.allSettled(['
    );
    const orderFetch1000 = "        fetch('/api/trade/orders?limit=1000', {cache:'no-store'})";
    const orderFetch100 = "        fetch('/api/trade/orders?limit=100', {cache:'no-store'})";
    if (pnl.includes(orderFetch1000)) {
      pnl = pnl.replace(orderFetch1000, orderFetch1000 + ",\n        fetch('/api/diagnostics/db-pnl', {cache:'no-store'})");
    } else if (pnl.includes(orderFetch100)) {
      pnl = pnl.replace(orderFetch100, orderFetch100 + ",\n        fetch('/api/diagnostics/db-pnl', {cache:'no-store'})");
    } else {
      throw new Error('database P&L runtime fetch anchor not found');
    }
  }

  const paintAnchor = "      if (byId('ledgerSub')) byId('ledgerSub').textContent = 'Actual Kalshi ETH ledger · ' + fillMessage + ' · ' + orderMessage;";
  const paintBlock = `      if (dbPnlResult.status === 'fulfilled' && dbPnlResult.value.ok) {\n        const dbPnl = await dbPnlResult.value.json();\n        if (Array.isArray(dbPnl?.days)) {\n          paintSummary(dbPnl.days);\n          fillMessage += ' · P&L from durable DB ledger';\n        }\n      }\n\n` + paintAnchor;
  if (!pnl.includes('P&L from durable DB ledger')) {
    if (!pnl.includes(paintAnchor)) throw new Error('database P&L runtime paint anchor not found');
    pnl = pnl.replace(paintAnchor, paintBlock);
  }
} else {
  // Compact runtime. Keep detailed fill/order analytics intact, but make the
  // durable database daily ledger authoritative for the summary cards/table.
  const compactFetchOld = "const[fr,or]=await Promise.allSettled([fills(),orders()]);";
  const compactFetchNew = "const[fr,or,dr]=await Promise.allSettled([fills(),orders(),fetch('/api/diagnostics/db-pnl',{cache:'no-store'})]);";
  if (!pnl.includes(compactFetchNew)) {
    if (!pnl.includes(compactFetchOld)) throw new Error('database P&L compact runtime fetch anchor not found');
    pnl = pnl.replace(compactFetchOld, compactFetchNew);
  }

  const compactSummaryOld = "if(fr.status==='fulfilled'){const z=summarize(fr.value.rows,idx);fm=z.orders;summary(z.days);analytics([...z.orders.values()],z.days)}";
  const compactSummaryNew = "if(fr.status==='fulfilled'){const z=summarize(fr.value.rows,idx);fm=z.orders;summary(z.days);analytics([...z.orders.values()],z.days)}if(dr.status==='fulfilled'&&dr.value.ok){const db=await dr.value.json();if(Array.isArray(db?.days))summary(db.days)}";
  if (!pnl.includes(compactSummaryNew)) {
    if (!pnl.includes(compactSummaryOld)) throw new Error('database P&L compact runtime paint anchor not found');
    pnl = pnl.replace(compactSummaryOld, compactSummaryNew);
  }

  if (!pnl.includes("fetch('/api/diagnostics/db-pnl'")) throw new Error('database P&L compact runtime fetch was not applied');
  if (!pnl.includes("if(Array.isArray(db?.days))summary(db.days)")) throw new Error('database P&L compact runtime summary was not applied');
}

fs.writeFileSync(pnlPath, pnl);
