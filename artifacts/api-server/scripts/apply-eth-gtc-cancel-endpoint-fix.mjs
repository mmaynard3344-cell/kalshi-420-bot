import fs from 'node:fs';

const path = new URL('../src/lib/strategies/ethOnlyMartingale.ts', import.meta.url);
let source = fs.readFileSync(path, 'utf8');

const before = '"DELETE", `/portfolio/events/orders/${encodeURIComponent(order.kalshiOrderId)}`,';
const after = '"DELETE", `/portfolio/orders/${encodeURIComponent(order.kalshiOrderId)}`,';

const matches = source.split(before).length - 1;
if (matches === 1) {
  source = source.replace(before, after);
} else if (matches === 0 && source.includes(after)) {
  // Idempotent on rebuilds where the source already contains the corrected endpoint.
} else {
  throw new Error(`ETH GTC cancel endpoint anchor count was ${matches}; expected exactly 1`);
}

if (!source.includes(after)) throw new Error('ETH GTC cancel endpoint proof missing');
fs.writeFileSync(path, source);
console.log('ETH GTC cancel endpoint fixed: DELETE /portfolio/orders/{order_id}');
