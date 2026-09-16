import { readFileSync, writeFileSync } from 'node:fs';

const path = new URL('../server.mjs', import.meta.url);
let src = readFileSync(path, 'utf8');
const marker = 'shawshank-j-rescue-research-v2';
if (src.includes(marker)) {
  console.log(`${marker}: already installed`);
  process.exit(0);
}

const fnAnchor = 'function serveStatic(req, res, url) {';
if (!src.includes(fnAnchor)) throw new Error('J research patch: serveStatic anchor missing');

const researchFn = `
// ${marker}: READ-ONLY diagnostic. No exchange/order/state mutation paths.
async function computeJRescueResearch() {
  const data = await withReadOnlyDb(async (client) => {
    const orders = await client.query(\`
      SELECT * FROM eth420_candidate_live_orders
      WHERE created_at_ms >= $1
      ORDER BY created_at_ms ASC
      LIMIT 5000
    \`, [Date.now() - 30 * 24 * 60 * 60_000]);
    if (!orders.rows.length) return { orders: [], snapshots: [] };
    const snapshots = await client.query(\`
      SELECT * FROM eth420_candidate_execution_snapshots
      WHERE candidate_order_id = ANY($1::text[])
      ORDER BY candidate_order_id ASC
      LIMIT 25000
    \`, [orders.rows.map((r) => String(r.id))]);
    return { orders: orders.rows, snapshots: snapshots.rows };
  });

  const pick = (row, ...names) => {
    for (const name of names) if (row?.[name] != null) return row[name];
    return null;
  };
  const num = (v) => v == null || v === '' ? null : Number(v);
  const byOrder = new Map();
  for (const s of data.snapshots) {
    const id = String(pick(s, 'candidate_order_id', 'candidateOrderId') ?? '');
    if (!id) continue;
    const offset = num(pick(s, 'scheduled_offset_ms', 'scheduledOffsetMs', 'offset_ms', 'offsetMs'));
    if (![1000, 2000, 5000, 10000].includes(offset)) continue;
    if (!byOrder.has(id)) byOrder.set(id, new Map());
    byOrder.get(id).set(offset, {
      offsetMs: offset,
      state: String(pick(s, 'observation_state', 'observationState') ?? ''),
      orderStatus: String(pick(s, 'order_status', 'orderStatus') ?? ''),
      filled: num(pick(s, 'filled_contracts', 'filledContracts')),
      ask: num(pick(s, 'selected_best_ask_cents', 'selectedBestAskCents')),
      bid: num(pick(s, 'selected_best_bid_cents', 'selectedBestBidCents')),
      depth50: num(pick(s, 'depth_at_50_contracts', 'depthAt50Contracts')),
      executable: num(pick(s, 'full_size_executable_price_cents', 'fullSizeExecutablePriceCents')),
    });
  }

  const orderKeys = data.orders[0] ? Object.keys(data.orders[0]) : [];
  const terminalNames = ['settled','finalized','closed','resolved','is_settled','is_finalized','is_closed','is_resolved'];
  const statusNames = ['status','order_status','orderStatus','settlement_status','settlementStatus','result_status','resultStatus'];
  const terminalStatus = new Set(['settled','finalized','closed','resolved','complete','completed','cancelled','canceled','expired']);
  const isTerminal = (o) => {
    for (const n of terminalNames) {
      const v = o?.[n];
      if (v === true || v === 1 || String(v).toLowerCase() === 'true') return true;
    }
    for (const n of statusNames) {
      const v = o?.[n];
      if (v != null && terminalStatus.has(String(v).toLowerCase())) return true;
    }
    return false;
  };

  const rows = data.orders.map((o) => {
    const id = String(o.id ?? '');
    const snaps = byOrder.get(id) ?? new Map();
    const filled = num(pick(o, 'filled_contracts', 'filledContracts')) ?? 0;
    const terminal = isTerminal(o);
    return {
      id, ticker: String(o.ticker ?? ''), side: String(o.side ?? ''),
      createdAtMs: num(pick(o, 'created_at_ms', 'createdAtMs')),
      finalFilledContracts: filled,
      terminal,
      label: filled > 0 ? 'A_LATER_FILLED' : terminal ? 'A_NEVER_FILLED' : 'UNKNOWN',
      plus1: snaps.get(1000) ?? null,
      plus2: snaps.get(2000) ?? null,
      plus5: snaps.get(5000) ?? null,
      plus10: snaps.get(10000) ?? null,
    };
  }).filter((r) => r.plus1 || r.plus2 || r.plus5 || r.plus10);

  const known = rows.filter((r) => r.label !== 'UNKNOWN');
  const eligible = (s) => s && s.state === 'captured' && s.orderStatus === 'resting' && s.filled === 0;
  const gates = [];
  for (const offset of [1000, 2000, 5000, 10000]) {
    for (const askThreshold of [55, 60, 65, 70, 75, 80, 85, 90]) {
      let tp=0, fp=0, fn=0, tn=0;
      for (const r of known) {
        const s = r['plus' + (offset/1000)];
        const fire = eligible(s) && s.ask != null && s.ask >= askThreshold;
        const truth = r.label === 'A_NEVER_FILLED';
        if (fire && truth) tp++; else if (fire) fp++; else if (truth) fn++; else tn++;
      }
      gates.push({offsetMs:offset, askAtLeast:askThreshold,tp,fp,fn,tn,
        precision: tp+fp ? tp/(tp+fp) : null,
        recall: tp+fn ? tp/(tp+fn) : null,
        fired: tp+fp});
    }
  }
  gates.sort((a,b) => (b.precision ?? -1) - (a.precision ?? -1) || b.tp-a.tp || a.offsetMs-b.offsetMs);
  const counts = rows.reduce((a,r) => (a[r.label]=(a[r.label]??0)+1,a),{});
  return { generatedAtMs: Date.now(), marker: '${marker}', readOnly: true,
    population: {rows: rows.length, known: known.length, ...counts},
    topGates: gates.slice(0,20), allGates:gates,
    schema: {orderKeys, snapshotKeys:data.snapshots[0] ? Object.keys(data.snapshots[0]) : []},
    rows };
}

async function jRescueResearchDiagnostics(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
  try {
    const result = await computeJRescueResearch();
    if (req.method === 'HEAD') return send(res, 200, '', 'application/json; charset=utf-8');
    return send(res, 200, JSON.stringify(result), 'application/json; charset=utf-8');
  } catch (error) {
    console.error('J rescue research diagnostic failed', error);
    return send(res, 500, JSON.stringify({error:String(error?.message ?? error)}), 'application/json; charset=utf-8');
  }
}

setTimeout(async () => {
  try {
    const result = await computeJRescueResearch();
    const compact = { generatedAtMs: result.generatedAtMs, marker: result.marker, readOnly: result.readOnly,
      population: result.population, topGates: result.topGates, schema: result.schema };
    console.log('J_RESCUE_RESEARCH_RESULT ' + JSON.stringify(compact));
  } catch (error) {
    console.error('J_RESCUE_RESEARCH_STARTUP_FAILED', error);
  }
}, 5000);

`;
src = src.replace(fnAnchor, researchFn + fnAnchor);

const routeAnchor = '  if (url.pathname === \'/api/diagnostics/exchange';
const idx = src.indexOf(routeAnchor);
if (idx < 0) throw new Error('J research patch: route anchor missing');
src = src.slice(0, idx) + "  if (url.pathname === '/api/diagnostics/j-rescue-research') return void jRescueResearchDiagnostics(req, res);\n" + src.slice(idx);

writeFileSync(path, src);
console.log(`${marker}: installed`);
