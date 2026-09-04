import fs from 'node:fs';

const serverPath = new URL('../server.mjs', import.meta.url);
let server = fs.readFileSync(serverPath, 'utf8');
const oldSelect = `      SELECT source_candidate_order_id,source_ticker,missed_side,source_open_time_ms,target_open_time_ms,status,armed_at_ms`;
const newSelect = `      SELECT source_candidate_order_id,source_ticker,missed_side,source_open_time_ms,target_open_time_ms,status,armed_at_ms,\n             target_ticker,selected_side,execution_mode,execution_limit_price_cents,candidate_order_id,fallback_reason,resolved_at_ms`;
if (!server.includes(newSelect)) {
  if (!server.includes(oldSelect)) throw new Error('route proof: Back Flip SELECT anchor not found');
  server = server.replace(oldSelect, newSelect);
}
const oldMap = `      targetOpenTimeMs: Number(row.target_open_time_ms), status: String(row.status ?? ''), armedAtMs: Number(row.armed_at_ms),`;
const newMap = `      targetOpenTimeMs: Number(row.target_open_time_ms), status: String(row.status ?? ''), armedAtMs: Number(row.armed_at_ms),\n      targetTicker: row.target_ticker == null ? null : String(row.target_ticker),\n      selectedSide: row.selected_side == null ? null : String(row.selected_side),\n      executionMode: row.execution_mode == null ? null : String(row.execution_mode),\n      executionLimitPriceCents: row.execution_limit_price_cents == null ? null : Number(row.execution_limit_price_cents),\n      candidateOrderId: row.candidate_order_id == null ? null : String(row.candidate_order_id),\n      fallbackReason: row.fallback_reason == null ? null : String(row.fallback_reason),\n      resolvedAtMs: row.resolved_at_ms == null ? null : Number(row.resolved_at_ms),`;
if (!server.includes(newMap)) {
  if (!server.includes(oldMap)) throw new Error('route proof: Back Flip map anchor not found');
  server = server.replace(oldMap, newMap);
}
fs.writeFileSync(serverPath, server);

const opsPath = new URL('../public/operations-core.js', import.meta.url);
let ops = fs.readFileSync(opsPath, 'utf8');
const oldHelpers = `  const backFlipWindows = (p) => { const rows=Array.isArray(p)?p:Array.isArray(p?.rows)?p.rows:[]; return rows.map(r=>num(first(r,['targetOpenTimeMs','target_open_time_ms']))).filter(Number.isFinite); };\n  const routeOf = (o, bfWindows, bfAvailable) => { const c=clientId(o); if(c.startsWith('eth-yes-')||c.startsWith('eth-no-'))return'Regular'; if(c.endsWith(':eth420-live-v1')){if(!bfAvailable)return'420 Special'; const t=orderTime(o); return bfWindows.some(w=>t>=w&&t<w+900000)?'Back Flip':'420 Jump';} return'ETH Order'; };`;
const newHelpers = `  const backFlipRows = (p) => Array.isArray(p)?p:Array.isArray(p?.rows)?p.rows:[];\n  const routeOf = (o, bfRows, bfAvailable) => {\n    const c=clientId(o);\n    if(c.startsWith('eth-yes-')||c.startsWith('eth-no-')) return 'Regular';\n    if(c.endsWith(':eth420-live-v1')) {\n      if(!bfAvailable) return '420 Special';\n      const oid=orderId(o), ticker=orderTicker(o);\n      const proved=bfRows.some(r=>{\n        const candidate=String(first(r,['candidateOrderId','candidate_order_id'])??'');\n        const target=String(first(r,['targetTicker','target_ticker'])??'');\n        return candidate && (candidate===c || candidate===oid) && (!target || target===ticker);\n      });\n      return proved ? 'Back Flip' : '420 Jump';\n    }\n    return 'ETH Order';\n  };`;
if (!ops.includes(newHelpers)) {
  if (!ops.includes(oldHelpers)) throw new Error('route proof: Operations route helper anchor not found');
  ops = ops.replace(oldHelpers, newHelpers);
}
ops = ops.replace('const results=settlementMap(fills); const bfWindows=backFlipWindows(bf);', 'const results=settlementMap(fills); const bfRows=backFlipRows(bf);');
ops = ops.replaceAll('routeOf(current,bfWindows,bfAvailable)', 'routeOf(current,bfRows,bfAvailable)');
ops = ops.replaceAll('routeOf(latest,bfWindows,bfAvailable)', 'routeOf(latest,bfRows,bfAvailable)');
fs.writeFileSync(opsPath, ops);
