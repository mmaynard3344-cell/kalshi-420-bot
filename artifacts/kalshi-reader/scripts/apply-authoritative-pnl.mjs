import fs from 'node:fs';

const serverPath = new URL('../server.mjs', import.meta.url);
let server = fs.readFileSync(serverPath, 'utf8');

const marker = 'async function databasePnlSummary(req, res) {';
if (!server.includes(marker)) {
  const anchor = 'function serveStatic(req, res, url) {';
  if (!server.includes(anchor)) throw new Error('database P&L server anchor not found');
  const block = `async function databasePnlSummary(req, res) {\n  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');\n  try {\n    const trades = await withReadOnlyDb(async (client) => {\n      const result = await client.query(\`\n        WITH regular AS (\n          SELECT\n            'Regular'::text AS strategy,\n            ('regular:' || id::text) AS trade_key,\n            kalshi_order_id::text AS order_id,\n            ticker::text AS ticker,\n            lower(side::text) AS side,\n            lower(settlement_result::text) AS settlement_result,\n            eastern_date,\n            created_at_ms::bigint AS created_at_ms,\n            filled_contracts::double precision AS filled_contracts,\n            ROUND(COALESCE(actual_notional_dollars, 0) * 100)::bigint AS wagered_cents,\n            ROUND(COALESCE(actual_fee_dollars, 0) * 100)::bigint AS fees_cents,\n            CASE\n              WHEN settlement_result = side THEN\n                ROUND(COALESCE(filled_contracts, 0) * 100 - COALESCE(actual_notional_dollars, 0) * 100 - COALESCE(actual_fee_dollars, 0) * 100)::bigint\n              ELSE\n                ROUND(-COALESCE(actual_notional_dollars, 0) * 100 - COALESCE(actual_fee_dollars, 0) * 100)::bigint\n            END AS net_cents\n          FROM eth_martingale_orders\n          WHERE ticker LIKE 'KXETH15M-%'\n            AND eastern_date >= '2026-08-27'\n            AND settlement_result IN ('yes','no')\n            AND filled_contracts IS NOT NULL AND filled_contracts > 0\n            AND actual_notional_dollars IS NOT NULL\n        ),\n        candidate AS (\n          SELECT\n            CASE\n              WHEN id::text LIKE '%:eth-jump-v1' THEN 'Jump'\n              WHEN id::text LIKE '%:eth-no3-reversal-v1' THEN 'Reversal'\n              WHEN id::text LIKE '%:eth420-live-v1' THEN 'Legacy 420'\n              ELSE NULL\n            END::text AS strategy,\n            ('candidate:' || id::text) AS trade_key,\n            kalshi_order_id::text AS order_id,\n            ticker::text AS ticker,\n            lower(side::text) AS side,\n            lower(settlement_result::text) AS settlement_result,\n            eastern_date,\n            created_at_ms::bigint AS created_at_ms,\n            filled_contracts::double precision AS filled_contracts,\n            ROUND(COALESCE(NULLIF(actual_notional_dollars, '')::numeric, 0) * 100)::bigint AS wagered_cents,\n            ROUND(COALESCE(NULLIF(actual_fee_dollars, '')::numeric, 0) * 100)::bigint AS fees_cents,\n            realized_pnl_delta_cents::bigint AS net_cents\n          FROM eth420_candidate_live_orders\n          WHERE ticker LIKE 'KXETH15M-%'\n            AND eastern_date >= '2026-08-27'\n            AND status = 'settled'\n            AND settlement_result IN ('yes','no')\n            AND filled_contracts IS NOT NULL AND filled_contracts > 0\n            AND realized_pnl_delta_cents IS NOT NULL\n        )\n        SELECT * FROM regular\n        UNION ALL\n        SELECT * FROM candidate\n        ORDER BY created_at_ms ASC\n      \`);\n      return result.rows;\n    });\n\n    const allowedStrategies = new Set(['Regular','Jump','Legacy 420','Reversal']);\n    const normalizedTrades = trades.map((row) => ({\n      tradeKey: String(row.trade_key),\n      orderId: row.order_id == null ? '' : String(row.order_id),\n      ticker: String(row.ticker),\n      strategy: row.strategy == null ? '' : String(row.strategy),\n      side: String(row.side ?? '').toLowerCase(),\n      result: String(row.settlement_result ?? '').toLowerCase(),\n      easternDate: String(row.eastern_date),\n      atMs: Number(row.created_at_ms ?? 0),\n      contracts: Number(row.filled_contracts ?? 0),\n      principalCents: Number(row.wagered_cents ?? 0),\n      feesCents: Number(row.fees_cents ?? 0),\n      netCents: Number(row.net_cents ?? 0),\n    }));\n\n    const unclassified = normalizedTrades.filter((row) => !allowedStrategies.has(row.strategy));\n    if (unclassified.length) throw new Error('Unclassified durable P&L rows: ' + unclassified.map((row) => row.tradeKey).join(', '));\n    for (const row of normalizedTrades) {\n      if (row.side !== 'yes' && row.side !== 'no') throw new Error('Invalid durable side for ' + row.tradeKey);\n      if (row.result !== 'yes' && row.result !== 'no') throw new Error('Invalid durable result for ' + row.tradeKey);\n      row.won = row.side === row.result;\n    }\n\n    const dayMap = new Map();\n    for (const row of normalizedTrades) {\n      const day = dayMap.get(row.easternDate) ?? { easternDate: row.easternDate, bets: 0, settled: 0, wins: 0, losses: 0, wageredCents: 0, feesCents: 0, netCents: 0 };\n      day.bets += 1;\n      day.settled += 1;\n      day.wins += row.won ? 1 : 0;\n      day.losses += row.won ? 0 : 1;\n      day.wageredCents += row.principalCents;\n      day.feesCents += row.feesCents;\n      day.netCents += row.netCents;\n      dayMap.set(row.easternDate, day);\n    }\n    const days = [...dayMap.values()].sort((a, b) => a.easternDate.localeCompare(b.easternDate));\n    const totalNetCents = normalizedTrades.reduce((sum, row) => sum + row.netCents, 0);\n    const strategyNetCents = Object.fromEntries([...allowedStrategies].map((strategy) => [strategy, normalizedTrades.filter((row) => row.strategy === strategy).reduce((sum, row) => sum + row.netCents, 0)]));\n    const strategyTotalCents = Object.values(strategyNetCents).reduce((sum, value) => sum + Number(value), 0);\n    if (strategyTotalCents !== totalNetCents) throw new Error('Strategy P&L reconciliation failed');\n\n    const response = {\n      available: true,\n      generatedAtMs: Date.now(),\n      method: 'durable_postgres_transaction_ledgers',\n      days,\n      trades: normalizedTrades,\n      proof: {\n        totalNetCents,\n        dayTotalNetCents: days.reduce((sum, day) => sum + day.netCents, 0),\n        strategyNetCents,\n        strategyTotalCents,\n        settledTrades: normalizedTrades.length,\n        unclassifiedTrades: 0,\n      },\n    };\n    if (response.proof.dayTotalNetCents !== response.proof.totalNetCents) throw new Error('Daily P&L reconciliation failed');\n    if (req.method === 'HEAD') return send(res, 200, '', 'application/json; charset=utf-8');\n    return send(res, 200, JSON.stringify(response), 'application/json; charset=utf-8');\n  } catch (error) {\n    console.error('Database P&L summary failed', error);\n    return send(res, 500, JSON.stringify({ available: false, error: String(error?.message ?? 'Database P&L summary failed') }), 'application/json; charset=utf-8');\n  }\n}\n\n`;
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
  // Compact runtime. Fills remain execution-detail evidence only. Realized P&L,
  // win/loss, settled count, and strategy identity all come from durable rows.
  const compactFetchOld = "const[fr,or]=await Promise.allSettled([fills(),orders()]);";
  const compactFetchPrior = "const[fr,or,dr]=await Promise.allSettled([fills(),orders(),fetch('/api/diagnostics/db-pnl',{cache:'no-store'})]);";
  const compactFetchNew = compactFetchPrior;
  if (!pnl.includes(compactFetchNew)) {
    if (!pnl.includes(compactFetchOld)) throw new Error('database P&L compact runtime fetch anchor not found');
    pnl = pnl.replace(compactFetchOld, compactFetchNew);
  }

  const compactSummaryOld = "if(fr.status==='fulfilled'){const z=summarize(fr.value.rows,idx);fm=z.orders;summary(z.days);analytics([...z.orders.values()],z.days)}";
  const compactSummaryPrior = "if(fr.status==='fulfilled'){const z=summarize(fr.value.rows,idx);fm=z.orders;summary(z.days);analytics([...z.orders.values()],z.days)}if(dr.status==='fulfilled'&&dr.value.ok){const db=await dr.value.json();if(Array.isArray(db?.days))summary(db.days)}";
  const compactSummaryNew = "if(fr.status==='fulfilled'){const z=summarize(fr.value.rows,idx);fm=z.orders}if(dr.status==='fulfilled'&&dr.value.ok){const db=await dr.value.json();if(Array.isArray(db?.days)&&Array.isArray(db?.trades)){const auth=db.trades.map(t=>{const f=fm.get(String(t.orderId||''));return{...t,avgFillPriceCents:f?.avgFillPriceCents??null,atMs:f?.atMs??t.atMs}});summary(db.days);analytics(auth,db.days)}}";
  if (!pnl.includes(compactSummaryNew)) {
    if (pnl.includes(compactSummaryPrior)) pnl = pnl.replace(compactSummaryPrior, compactSummaryNew);
    else if (pnl.includes(compactSummaryOld)) pnl = pnl.replace(compactSummaryOld, compactSummaryNew);
    else throw new Error('database P&L compact runtime paint anchor not found');
  }

  if (!pnl.includes("fetch('/api/diagnostics/db-pnl'")) throw new Error('database P&L compact runtime fetch was not applied');
  if (!pnl.includes("analytics(auth,db.days)")) throw new Error('authoritative strategy analytics were not applied');
  if (pnl.includes("analytics([...z.orders.values()],z.days)")) throw new Error('fills-derived strategy analytics still active');
}

fs.writeFileSync(pnlPath, pnl);
