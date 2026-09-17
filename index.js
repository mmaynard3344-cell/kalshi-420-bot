const { createRequire } = require('module');
const http = require('http');
const req = createRequire(process.cwd() + '/lib/db/package.json');
const { Pool } = req('pg');

const END_ET_DATE = '2026-09-16';
const strategyMap = {
  jump: 'B',
  reversal: 'C',
  breakout_reversal: 'D',
  downfade_p80_p90: 'E',
  downfade_p90_p95: 'F',
  downfade_p95_p99: 'H',
  ash_v2_i: 'I',
};

function iso(ms) { return new Date(Number(ms)).toISOString(); }
function n(v) { return v == null ? null : Number(v); }
function round(v) { return v == null || !Number.isFinite(Number(v)) ? null : Math.round(Number(v)); }

async function loadExport() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout = '15000ms'");

    const a = await client.query(`
      SELECT id,ticker,side,settlement_result,created_at_ms,settled_at_ms,
             filled_contracts,actual_fill_price_cents,no_price_cents,
             actual_notional_dollars,actual_fee_dollars,filled_fee_cents,generation
      FROM eth_martingale_orders
      WHERE settlement_result IN ('yes','no')
        AND COALESCE(filled_contracts,0) > 0
        AND (to_timestamp(created_at_ms/1000.0) AT TIME ZONE 'America/New_York')::date <= $1::date
      ORDER BY created_at_ms,id
    `,[END_ET_DATE]);

    const big = await client.query(`
      SELECT id,strategy,order_tag,ticker,side,wager_cents,actual_notional_cents,
             actual_fee_cents,realized_pnl_cents,filled_contracts,fill_price_cents,
             settlement_result,created_at_ms,updated_at_ms
      FROM eth_big_bet_orders
      WHERE settlement_result IN ('yes','no')
        AND COALESCE(filled_contracts,0) > 0
        AND strategy IN ('jump','reversal','breakout_reversal','downfade_p80_p90','downfade_p90_p95','downfade_p95_p99','ash_v2_i')
        AND NOT (strategy='jump' AND order_tag='diagnostic-reservation-probe-v1')
        AND (to_timestamp(created_at_ms/1000.0) AT TIME ZONE 'America/New_York')::date <= $1::date
      ORDER BY created_at_ms,id
    `,[END_ET_DATE]);

    await client.query('COMMIT');

    const rows = [];
    for (const r of a.rows) {
      const contracts = n(r.filled_contracts) || 0;
      const price = n(r.actual_fill_price_cents) ?? n(r.no_price_cents) ?? 50;
      const notionalCents = r.actual_notional_dollars != null
        ? round(Number(r.actual_notional_dollars) * 100)
        : round(contracts * price);
      const feeCents = r.actual_fee_dollars != null
        ? round(Number(r.actual_fee_dollars) * 100)
        : round(r.filled_fee_cents) ?? 0;
      const win = String(r.settlement_result).toLowerCase() === String(r.side).toLowerCase();
      const pnlCents = win
        ? round(contracts * 100 - notionalCents - feeCents)
        : round(-notionalCents - feeCents);
      rows.push({
        service:'A', ticker:r.ticker, side:String(r.side).toLowerCase(),
        result:String(r.settlement_result).toLowerCase(),
        wager_cents:notionalCents, fee_cents:feeCents, pnl_cents:pnlCents,
        timestamp:iso(r.created_at_ms)
      });
    }

    for (const r of big.rows) {
      rows.push({
        service:strategyMap[r.strategy], ticker:r.ticker, side:String(r.side).toLowerCase(),
        result:String(r.settlement_result).toLowerCase(),
        wager_cents:round(r.wager_cents), fee_cents:round(r.actual_fee_cents) ?? 0,
        pnl_cents:round(r.realized_pnl_cents), timestamp:iso(r.created_at_ms)
      });
    }

    rows.sort((x,y)=>x.timestamp.localeCompare(y.timestamp)||x.service.localeCompare(y.service));
    const byService = {};
    for (const r of rows) byService[r.service]=(byService[r.service]||0)+1;
    return {
      rows,
      meta:{
        end_et_date:END_ET_DATE,
        earliest_timestamp:rows[0]?.timestamp ?? null,
        latest_timestamp:rows.at(-1)?.timestamp ?? null,
        row_count:rows.length,
        by_service:byService,
        note:'Filled and settled/resolved production orders only; G/J/K excluded. A includes all A generations present in eth_martingale_orders.'
      }
    };
  } finally {
    client.release();
    await pool.end();
  }
}

(async()=>{
  let data;
  try {
    data=await loadExport();
    console.log('EXPORT_META '+JSON.stringify(data.meta));
  } catch(err) {
    console.error('EXPORT_ERROR',err && err.stack ? err.stack : err);
    process.exit(1);
  }
  const json=JSON.stringify(data.rows,null,2)+'\n';
  const metaJson=JSON.stringify(data.meta,null,2)+'\n';
  const port=Number(process.env.PORT||3000);
  http.createServer((req,res)=>{
    const p=new URL(req.url||'/', 'http://localhost').pathname;
    if(p==='/'||p==='/health') { res.writeHead(200,{'content-type':'text/plain'}); return res.end('ready\n/export.json\n/meta.json\n'); }
    if(p==='/meta.json') { res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'}); return res.end(metaJson); }
    if(p==='/export.json') {
      res.writeHead(200,{'content-type':'application/json','content-disposition':'attachment; filename="shawshank-settled-A-B-C-D-E-F-H-I-through-2026-09-16-ET.json"','cache-control':'no-store','content-length':Buffer.byteLength(json)});
      return res.end(json);
    }
    res.writeHead(404); res.end('not found\n');
  }).listen(port,'0.0.0.0',()=>console.log('EXPORT_SERVER_READY port='+port));
})();
