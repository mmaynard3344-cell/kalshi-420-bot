import fs from 'node:fs';

const pnlPath = new URL('../public/pnl-runtime.js', import.meta.url);
let pnl = fs.readFileSync(pnlPath, 'utf8');

// Preserve the economic-side invariant for both the original formatted runtime
// and the compact presentation runtime. Kalshi fill-side text is not sufficient
// for NO purchases, so prefer the linked order side and only then use guarded
// client-id / price-pair / bid-ask fallbacks.
const oldSide = "  const side = (row) => String(row?.side || '').toLowerCase();";
const priorSide = `  const side = (row) => {\n    const parse = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : null; };\n    const yes = parse(row?.yes_price_dollars ?? row?.yes_price);\n    const no = parse(row?.no_price_dollars ?? row?.no_price);\n    if (yes != null || no != null) {\n      if (no == null) return 'yes';\n      if (yes == null) return 'no';\n      return no > yes ? 'no' : 'yes';\n    }\n    const raw = String(row?.side || '').toLowerCase();\n    return raw === 'yes' || raw === 'no' ? raw : '';\n  };`;
const newSide = `  const side = (row) => {\n    const client = String(row?.client_order_id ?? row?.clientOrderId ?? '');\n    if (client.startsWith('eth-yes-')) return 'yes';\n    if (client.startsWith('eth-no-')) return 'no';\n    const parse = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : null; };\n    const yes = parse(row?.yes_price_dollars ?? row?.yes_price);\n    const no = parse(row?.no_price_dollars ?? row?.no_price);\n    if (yes != null && no != null && yes !== no) return no > yes ? 'no' : 'yes';\n    const raw = String(row?.side || '').toLowerCase();\n    if (raw === 'bid') return 'yes';\n    if (raw === 'ask') return 'no';\n    if (raw === 'yes' || raw === 'no') return raw;\n    if (no == null && yes != null) return 'yes';\n    if (yes == null && no != null) return 'no';\n    return '';\n  };`;

const compactOldSide = "side=r=>String(r?.side||'').toLowerCase()";
const compactPriorSide = "side=r=>{const p=v=>{const n=Number(v);return Number.isFinite(n)&&n>=0?n:null},y=p(r?.yes_price_dollars??r?.yes_price),n=p(r?.no_price_dollars??r?.no_price);if(y!=null||n!=null){if(n==null)return'yes';if(y==null)return'no';return n>y?'no':'yes'}const raw=String(r?.side||'').toLowerCase();return raw==='yes'||raw==='no'?raw:''}";
const compactNewSide = "side=r=>{const client=String(r?.client_order_id??r?.clientOrderId??'');if(client.startsWith('eth-yes-'))return'yes';if(client.startsWith('eth-no-'))return'no';const p=v=>{const n=Number(v);return Number.isFinite(n)&&n>=0?n:null},y=p(r?.yes_price_dollars??r?.yes_price),n=p(r?.no_price_dollars??r?.no_price);if(y!=null&&n!=null&&y!==n)return n>y?'no':'yes';const raw=String(r?.side||'').toLowerCase();if(raw==='bid')return'yes';if(raw==='ask')return'no';if(raw==='yes'||raw==='no')return raw;if(n==null&&y!=null)return'yes';if(y==null&&n!=null)return'no';return''}";

if (!pnl.includes(newSide) && !pnl.includes(compactNewSide)) {
  if (pnl.includes(priorSide)) pnl = pnl.replace(priorSide, newSide);
  else if (pnl.includes(oldSide)) pnl = pnl.replace(oldSide, newSide);
  else if (pnl.includes(compactPriorSide)) pnl = pnl.replace(compactPriorSide, compactNewSide);
  else if (pnl.includes(compactOldSide)) pnl = pnl.replace(compactOldSide, compactNewSide);
  else throw new Error('P&L economic-side anchor not found');
}

// Original formatted runtime: require a fill -> order_id -> authoritative side map.
if (pnl.includes('function summarizeFills')) {
  if (!pnl.includes('function summarizeFills(fills, orderSideById = new Map())')) {
    const anchor = '  function summarizeFills(fills) {';
    if (!pnl.includes(anchor)) throw new Error('P&L summarizeFills anchor not found');
    pnl = pnl.replace(anchor, '  function summarizeFills(fills, orderSideById = new Map()) {');
  }

  const fillSideOld = `      const ms = rowTimeMs(fill);\n      const s = side(fill);\n      const count = fillCount(fill);`;
  const fillSideNew = `      const ms = rowTimeMs(fill);\n      const linkedOrderSide = orderSideById.get(orderId(fill));\n      const s = linkedOrderSide === 'yes' || linkedOrderSide === 'no' ? linkedOrderSide : side(fill);\n      const count = fillCount(fill);`;
  if (!pnl.includes(fillSideNew)) {
    if (!pnl.includes(fillSideOld)) throw new Error('P&L fill-side join anchor not found');
    pnl = pnl.replace(fillSideOld, fillSideNew);
  }

  const refreshOld = `      let fillMap = new Map();\n      let fillMessage = 'fills unavailable';\n      let orderMessage = 'orders unavailable';\n\n      if (fillResult.status === 'fulfilled' && fillResult.value.ok) {\n        const payload = await fillResult.value.json();\n        const fills = Array.isArray(payload?.fills) ? payload.fills : [];\n        const summary = summarizeFills(fills);\n        fillMap = summary.orders;\n        paintSummary(summary.days);\n        fillMessage = summary.orders.size + ' filled orders';\n      }\n\n      if (orderResult.status === 'fulfilled' && orderResult.value.ok) {\n        const payload = await orderResult.value.json();\n        const orders = Array.isArray(payload?.orders) ? payload.orders : [];\n        paintOrders(orders, fillMap);\n        orderMessage = orders.filter(isEth).length + ' recent ETH orders';\n      }`;
  const refreshNew = `      let fillMap = new Map();\n      let fillMessage = 'fills unavailable';\n      let orderMessage = 'orders unavailable';\n      let orders = [];\n      const orderSideById = new Map();\n\n      if (orderResult.status === 'fulfilled' && orderResult.value.ok) {\n        const payload = await orderResult.value.json();\n        orders = Array.isArray(payload?.orders) ? payload.orders : [];\n        for (const order of orders) {\n          const id = orderId(order);\n          const s = side(order);\n          if (id && (s === 'yes' || s === 'no')) orderSideById.set(id, s);\n        }\n        orderMessage = orders.filter(isEth).length + ' recent ETH orders';\n      }\n\n      if (fillResult.status === 'fulfilled' && fillResult.value.ok) {\n        const payload = await fillResult.value.json();\n        const fills = Array.isArray(payload?.fills) ? payload.fills : [];\n        const summary = summarizeFills(fills, orderSideById);\n        fillMap = summary.orders;\n        paintSummary(summary.days);\n        fillMessage = summary.orders.size + ' filled orders';\n      }\n\n      if (orderResult.status === 'fulfilled' && orderResult.value.ok) paintOrders(orders, fillMap);`;
  if (!pnl.includes(refreshNew)) {
    if (pnl.includes(refreshOld)) pnl = pnl.replace(refreshOld, refreshNew);
    else if (!pnl.includes('fetchAllFills')) throw new Error('P&L refresh join anchor not found');
  }

  pnl = pnl.replace("fetch('/api/trade/orders?limit=100', {cache:'no-store'})", "fetch('/api/trade/orders?limit=1000', {cache:'no-store'})");
} else {
  // Compact runtime: it already fetches/paginates orders first-class and passes
  // the full order index into summarize(fs, idx). Enforce that the economic side
  // is taken from idx.get(order_id) before falling back to fill normalization.
  const compactJoinOld = "function summarize(fs,idx){const om=new Map;for(const f of fs){if(!eth(f))continue;const t=ms(f),s=side(f),n=count(f),p=price(f,s);";
  const compactJoinNew = "function summarize(fs,idx){const om=new Map;for(const f of fs){if(!eth(f))continue;const t=ms(f),linked=idx.get(oid(f)),linkedSide=side(linked),s=linkedSide==='yes'||linkedSide==='no'?linkedSide:side(f),n=count(f),p=price(f,s);";
  if (!pnl.includes(compactJoinNew)) {
    if (!pnl.includes(compactJoinOld)) throw new Error('P&L compact fill-side join anchor not found');
    pnl = pnl.replace(compactJoinOld, compactJoinNew);
  }

  const compactRefreshProof = "const z=summarize(fr.value.rows,idx);";
  if (!pnl.includes(compactRefreshProof)) throw new Error('P&L compact refresh join anchor not found');
  if (!pnl.includes("idx=or.value.index")) throw new Error('P&L compact order index anchor not found');
}

fs.writeFileSync(pnlPath, pnl);
