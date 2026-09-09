import fs from 'node:fs';

const serverPath = new URL('../server.mjs', import.meta.url);
let server = fs.readFileSync(serverPath, 'utf8');

const marker = 'async function sharedAccountPnlSummary(req, res) {';
if (!server.includes(marker)) {
  const anchor = 'function serveStatic(req, res, url) {';
  if (!server.includes(anchor)) throw new Error('shared account P&L server anchor not found');
  const block = `async function sharedAccountPnlSummary(req, res) {\n  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');\n  try {\n    const payload = await withReadOnlyDb(async (client) => {\n      const functions = await client.query(\`\n        SELECT to_regprocedure('eth_account_realized_pnl_cents(text)') IS NOT NULL AS realized_ready,\n               to_regprocedure('eth_account_open_risk_cents(text)') IS NOT NULL AS risk_ready\n      \`);\n      if (!functions.rows[0]?.realized_ready) throw new Error('shared account P&L function is not installed');\n\n      const result = await client.query(\`\n        WITH dates AS (\n          SELECT DISTINCT eastern_date::text AS eastern_date\n          FROM eth_martingale_orders\n          WHERE ticker LIKE 'KXETH15M-%' AND eastern_date >= '2026-08-27'\n          UNION\n          SELECT DISTINCT to_char(to_timestamp(market_open_time_ms / 1000.0) AT TIME ZONE 'America/New_York', 'YYYY-MM-DD') AS eastern_date\n          FROM eth_big_bet_orders\n          WHERE market_open_time_ms IS NOT NULL\n            AND to_char(to_timestamp(market_open_time_ms / 1000.0) AT TIME ZONE 'America/New_York', 'YYYY-MM-DD') >= '2026-08-27'\n        ),\n        regular AS (\n          SELECT eastern_date::text AS eastern_date,\n                 COUNT(*) FILTER (WHERE settlement_result IN ('yes','no') AND COALESCE(filled_contracts,0) > 0)::bigint AS settled,\n                 COUNT(*) FILTER (WHERE settlement_result IN ('yes','no') AND COALESCE(filled_contracts,0) > 0 AND settlement_result = side)::bigint AS wins,\n                 COUNT(*) FILTER (WHERE settlement_result IN ('yes','no') AND COALESCE(filled_contracts,0) > 0 AND settlement_result <> side)::bigint AS losses,\n                 COALESCE(ROUND(SUM(COALESCE(actual_fee_dollars,0) * 100)),0)::bigint AS fees_cents\n          FROM eth_martingale_orders\n          WHERE ticker LIKE 'KXETH15M-%' AND eastern_date >= '2026-08-27'\n          GROUP BY eastern_date\n        ),\n        big AS (\n          SELECT to_char(to_timestamp(market_open_time_ms / 1000.0) AT TIME ZONE 'America/New_York', 'YYYY-MM-DD') AS eastern_date,\n                 COUNT(*) FILTER (WHERE status = 'settled' AND realized_pnl_cents IS NOT NULL)::bigint AS settled,\n                 COUNT(*) FILTER (WHERE status = 'settled' AND realized_pnl_cents > 0)::bigint AS wins,\n                 COUNT(*) FILTER (WHERE status = 'settled' AND realized_pnl_cents IS NOT NULL AND realized_pnl_cents <= 0)::bigint AS losses\n          FROM eth_big_bet_orders\n          WHERE market_open_time_ms IS NOT NULL\n            AND to_char(to_timestamp(market_open_time_ms / 1000.0) AT TIME ZONE 'America/New_York', 'YYYY-MM-DD') >= '2026-08-27'\n          GROUP BY 1\n        )\n        SELECT d.eastern_date,\n               eth_account_realized_pnl_cents(d.eastern_date)::bigint AS net_cents,\n               (COALESCE(r.settled,0) + COALESCE(b.settled,0))::bigint AS settled,\n               (COALESCE(r.wins,0) + COALESCE(b.wins,0))::bigint AS wins,\n               (COALESCE(r.losses,0) + COALESCE(b.losses,0))::bigint AS losses,\n               (COALESCE(r.settled,0) + COALESCE(b.settled,0))::bigint AS bets,\n               COALESCE(r.fees_cents,0)::bigint AS fees_cents\n        FROM dates d\n        LEFT JOIN regular r USING (eastern_date)\n        LEFT JOIN big b USING (eastern_date)\n        ORDER BY d.eastern_date ASC\n      \`);\n\n      const todayResult = await client.query(\`\n        SELECT to_char(clock_timestamp() AT TIME ZONE 'America/New_York', 'YYYY-MM-DD') AS eastern_date\n      \`);\n      const today = String(todayResult.rows[0].eastern_date);\n      const state = await client.query(\`\n        SELECT eth_account_realized_pnl_cents($1)::bigint AS realized_cents,\n               CASE WHEN to_regprocedure('eth_account_open_risk_cents(text)') IS NOT NULL\n                 THEN eth_account_open_risk_cents($1)::bigint ELSE 0::bigint END AS open_risk_cents,\n               EXISTS(SELECT 1 FROM eth_account_daily_loss_locks WHERE eastern_date=$1) AS latched\n      \`, [today]);\n      return { rows: result.rows, today, state: state.rows[0] };\n    });\n\n    const days = payload.rows.map((row) => ({\n      easternDate: String(row.eastern_date),\n      netCents: Number(row.net_cents ?? 0),\n      bets: Number(row.bets ?? 0),\n      settled: Number(row.settled ?? 0),\n      wins: Number(row.wins ?? 0),\n      losses: Number(row.losses ?? 0),\n      feesCents: Number(row.fees_cents ?? 0),\n    }));\n    const response = {\n      available: true,\n      method: 'shared_eth_account_daily_loss_function',\n      generatedAtMs: Date.now(),\n      days,\n      today: {\n        easternDate: payload.today,\n        realizedPnlCents: Number(payload.state?.realized_cents ?? 0),\n        openRiskCents: Number(payload.state?.open_risk_cents ?? 0),\n        dailyLossThresholdCents: -120000,\n        latched: Boolean(payload.state?.latched),\n      },\n      proof: {\n        dayTotalNetCents: days.reduce((sum, day) => sum + day.netCents, 0),\n        settledTrades: days.reduce((sum, day) => sum + day.settled, 0),\n        sameFunctionAsRiskGuard: true,\n      },\n    };\n    if (req.method === 'HEAD') return send(res, 200, '', 'application/json; charset=utf-8');\n    return send(res, 200, JSON.stringify(response), 'application/json; charset=utf-8');\n  } catch (error) {\n    console.error('Shared account P&L summary failed', error);\n    return send(res, 500, JSON.stringify({ available: false, error: String(error?.message ?? 'Shared account P&L summary failed') }), 'application/json; charset=utf-8');\n  }\n}\n\n`;
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
const paintNew = "let fillItems=[],fillDays=[];if(fr.status==='fulfilled'){const z=summarize(fr.value.rows,idx);fm=z.orders;fillItems=[...z.orders.values()];fillDays=z.days}if(ar.status==='fulfilled'&&ar.value.ok){const account=await ar.value.json();if(Array.isArray(account?.days)){summary(account.days);analytics(fillItems,account.days);if($('ledgerSub')&&account?.today){$('ledgerSub').dataset.accountPnl='1';$('ledgerSub').title='Shared account realized P&L '+money(account.today.realizedPnlCents)+' · open risk '+money(account.today.openRiskCents,false)+' · same ledger as daily loss guard'}}}else if(fillDays.length){summary(fillDays);analytics(fillItems,fillDays)}";
if (pnl.includes(paintOld)) pnl = pnl.replace(paintOld, paintNew);
else if (!pnl.includes(paintNew)) throw new Error('shared account P&L runtime paint anchor not found');

pnl = pnl.replaceAll('Existing frontend-accessible ledger only.','Durable all-service ledger · same source as daily loss guard.');
pnl = pnl.replaceAll('actual Kalshi ETH orders and fills across Regular, Jump and Reversal strategies.','actual Kalshi ETH orders and fills across services A–G.');

if (!pnl.includes("fetch('/api/diagnostics/account-pnl'")) throw new Error('shared account P&L fetch not installed');
if (!pnl.includes('summary(account.days)')) throw new Error('shared account P&L summary not installed');

fs.writeFileSync(pnlPath, pnl);

const dashboardPath = new URL('../public/eth420-dashboard.html', import.meta.url);
let dashboard = fs.readFileSync(dashboardPath, 'utf8');
dashboard = dashboard.replaceAll('Existing frontend-accessible ledger only.','Durable all-service ledger · same source as daily loss guard.');
dashboard = dashboard.replaceAll('actual Kalshi ETH orders and fills across Regular, Jump and Reversal strategies.','actual Kalshi ETH orders and fills across services A–G.');
fs.writeFileSync(dashboardPath, dashboard);
