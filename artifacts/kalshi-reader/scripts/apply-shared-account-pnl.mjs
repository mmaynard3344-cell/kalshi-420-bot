import fs from 'node:fs';

const serverPath = new URL('../server.mjs', import.meta.url);
let server = fs.readFileSync(serverPath, 'utf8');

const marker = 'async function sharedAccountPnlSummary(req, res) {';
if (!server.includes(marker)) {
  const anchor = 'function serveStatic(req, res, url) {';
  if (!server.includes(anchor)) throw new Error('shared account P&L server anchor not found');
  const block = `async function sharedAccountPnlSummary(req, res) {\n  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');\n  try {\n    const payload = await withReadOnlyDb(async (client) => {\n      const functions = await client.query(\`\n        SELECT to_regprocedure('eth_account_realized_pnl_cents(text)') IS NOT NULL AS realized_ready,\n               to_regprocedure('eth_account_open_risk_cents(text)') IS NOT NULL AS risk_ready\n      \`);\n      if (!functions.rows[0]?.realized_ready) throw new Error('shared account P&L function is not installed');\n\n      const result = await client.query(\`\n        WITH parents AS (\n          SELECT DISTINCT ON (oa.order_id)\n                 oa.order_id,\n                 oa.eastern_date::text AS eastern_date,\n                 oa.ticker,\n                 lower(oa.side) AS side,\n                 lower(COALESCE(NULLIF(oa.settlement_result,''), mr.result)) AS result\n          FROM order_attempts oa\n          LEFT JOIN market_results mr ON mr.ticker = oa.ticker\n          WHERE oa.ticker LIKE 'KXETH15M-%'\n            AND oa.eastern_date >= '2026-08-27'\n            AND oa.order_id IS NOT NULL\n            AND COALESCE(oa.is_synthetic,false) = false\n            AND COALESCE(oa.reconciled,false) = true\n          ORDER BY oa.order_id, oa.updated_at DESC NULLS LAST\n        ),\n        fill_agg AS (\n          SELECT f.order_id,\n                 SUM(f.contracts)::numeric AS contracts,\n                 COALESCE(ROUND(SUM(COALESCE(f.exact_fee_dollars, f.fee_dollars::numeric) * 100)),0)::bigint AS fees_cents\n          FROM order_fills f\n          WHERE f.fill_id IS NOT NULL\n          GROUP BY f.order_id\n        ),\n        daily AS (\n          SELECT p.eastern_date,\n                 COUNT(*) FILTER (WHERE p.result IN ('yes','no') AND COALESCE(a.contracts,0) > 0)::bigint AS settled,\n                 COUNT(*) FILTER (WHERE p.result IN ('yes','no') AND COALESCE(a.contracts,0) > 0 AND p.result = p.side)::bigint AS wins,\n                 COUNT(*) FILTER (WHERE p.result IN ('yes','no') AND COALESCE(a.contracts,0) > 0 AND p.result <> p.side)::bigint AS losses,\n                 COALESCE(SUM(a.fees_cents),0)::bigint AS fees_cents\n          FROM parents p\n          JOIN fill_agg a ON a.order_id = p.order_id\n          GROUP BY p.eastern_date\n        )\n        SELECT d.eastern_date,\n               eth_account_realized_pnl_cents(d.eastern_date)::bigint AS net_cents,\n               d.settled::bigint AS settled,\n               d.wins::bigint AS wins,\n               d.losses::bigint AS losses,\n               d.settled::bigint AS bets,\n               d.fees_cents::bigint AS fees_cents\n        FROM daily d\n        ORDER BY d.eastern_date ASC\n      \`);\n\n      const todayResult = await client.query(\`\n        SELECT to_char(clock_timestamp() AT TIME ZONE 'America/New_York', 'YYYY-MM-DD') AS eastern_date\n      \`);\n      const today = String(todayResult.rows[0].eastern_date);\n      const state = await client.query(\`\n        SELECT eth_account_realized_pnl_cents($1)::bigint AS realized_cents,\n               CASE WHEN to_regprocedure('eth_account_open_risk_cents(text)') IS NOT NULL\n                 THEN eth_account_open_risk_cents($1)::bigint ELSE 0::bigint END AS open_risk_cents,\n               EXISTS(SELECT 1 FROM eth_account_daily_loss_locks WHERE eastern_date=$1) AS latched\n      \`, [today]);\n      return { rows: result.rows, today, state: state.rows[0] };\n    });\n\n    const days = payload.rows.map((row) => ({\n      easternDate: String(row.eastern_date),\n      netCents: Number(row.net_cents ?? 0),\n      bets: Number(row.bets ?? 0),\n      settled: Number(row.settled ?? 0),\n      wins: Number(row.wins ?? 0),\n      losses: Number(row.losses ?? 0),\n      feesCents: Number(row.fees_cents ?? 0),\n    }));\n    const response = {\n      available: true,\n      method: 'kalshi_exchange_reconciled_fill_ledger',\n      generatedAtMs: Date.now(),\n      days,\n      today: {\n        easternDate: payload.today,\n        realizedPnlCents: Number(payload.state?.realized_cents ?? 0),\n        openRiskCents: Number(payload.state?.open_risk_cents ?? 0),\n        dailyLossThresholdCents: -120000,\n        latched: Boolean(payload.state?.latched),\n      },\n      proof: {\n        dayTotalNetCents: days.reduce((sum, day) => sum + day.netCents, 0),\n        settledTrades: days.reduce((sum, day) => sum + day.settled, 0),\n        sameFunctionAsRiskGuard: true,\n        exchangeProvenOnly: true,\n      },\n    };\n    if (req.method === 'HEAD') return send(res, 200, '', 'application/json; charset=utf-8');\n    return send(res, 200, JSON.stringify(response), 'application/json; charset=utf-8');\n  } catch (error) {\n    console.error('Shared account P&L summary failed', error);\n    return send(res, 500, JSON.stringify({ available: false, error: String(error?.message ?? 'Shared account P&L summary failed') }), 'application/json; charset=utf-8');\n  }\n}\n\n`;
  server = server.replace(anchor, block + anchor);
}

const route = "  if (url.pathname === '/api/diagnostics/account-pnl') return void sharedAccountPnlSummary(req, res);";
if (!server.includes(route)) {
  const routeAnchor = "  if (url.pathname === '/api/diagnostics/db-pnl') return void databasePnlSummary(req, res);";
  if (!server.includes(routeAnchor)) throw new Error('shared account P&L route anchor not found');
  server = server.replace(routeAnchor, routeAnchor + '\n' + route);
}
fs.writeFileSync(serverPath, server);

const pnlPath = new URL('../public/pnl-runtime.js', import.meta.url);
let pnl = fs.readFileSync(pnlPath, 'utf8');

const fetchOld = "const[fr,or]=await Promise.allSettled([fills(),orders()]);";
const fetchNew = "const[fr,or,ar]=await Promise.allSettled([fills(),orders(),fetch('/api/diagnostics/account-pnl',{cache:'no-store'})]);";
if (pnl.includes(fetchOld)) pnl = pnl.replace(fetchOld, fetchNew);
else if (!pnl.includes(fetchNew)) throw new Error('shared account P&L runtime fetch anchor not found');

const paintOld = "if(fr.status==='fulfilled'){const z=summarize(fr.value.rows,idx);fm=z.orders;summary(z.days);analytics([...z.orders.values()],z.days)}";
const paintNew = "let fillItems=[],fillDays=[];if(fr.status==='fulfilled'){const z=summarize(fr.value.rows,idx);fm=z.orders;fillItems=[...z.orders.values()];fillDays=z.days}if(ar.status==='fulfilled'&&ar.value.ok){const account=await ar.value.json();if(Array.isArray(account?.days)){summary(account.days);analytics(fillItems,account.days);if($('ledgerSub')&&account?.today){$('ledgerSub').dataset.accountPnl='1';$('ledgerSub').title='Exchange-proven realized P&L '+money(account.today.realizedPnlCents)+' · open risk '+money(account.today.openRiskCents,false)+' · same ledger as daily loss guard'}}}else if(fillDays.length){summary(fillDays);analytics(fillItems,fillDays)}";
if (pnl.includes(paintOld)) pnl = pnl.replace(paintOld, paintNew);
else if (!pnl.includes(paintNew)) throw new Error('shared account P&L runtime paint anchor not found');

pnl = pnl.replaceAll('Existing frontend-accessible ledger only.','Kalshi exchange-proven ledger · same source as daily loss guard.');
pnl = pnl.replaceAll('Durable all-service ledger · same source as daily loss guard.','Kalshi exchange-proven ledger · same source as daily loss guard.');
pnl = pnl.replaceAll('actual Kalshi ETH orders and fills across Regular, Jump and Reversal strategies.','actual Kalshi ETH orders and fills across services A–H.');
pnl = pnl.replaceAll('actual Kalshi ETH orders and fills across services A–G.','actual Kalshi ETH orders and fills across services A–H.');

if (!pnl.includes("fetch('/api/diagnostics/account-pnl'")) throw new Error('shared account P&L fetch not installed');
if (!pnl.includes('summary(account.days)')) throw new Error('shared account P&L summary not installed');

fs.writeFileSync(pnlPath, pnl);

const dashboardPath = new URL('../public/eth420-dashboard.html', import.meta.url);
let dashboard = fs.readFileSync(dashboardPath, 'utf8');
dashboard = dashboard.replaceAll('Existing frontend-accessible ledger only.','Kalshi exchange-proven ledger · same source as daily loss guard.');
dashboard = dashboard.replaceAll('Durable all-service ledger · same source as daily loss guard.','Kalshi exchange-proven ledger · same source as daily loss guard.');
dashboard = dashboard.replaceAll('actual Kalshi ETH orders and fills across Regular, Jump and Reversal strategies.','actual Kalshi ETH orders and fills across services A–H.');
dashboard = dashboard.replaceAll('actual Kalshi ETH orders and fills across services A–G.','actual Kalshi ETH orders and fills across services A–H.');
fs.writeFileSync(dashboardPath, dashboard);
