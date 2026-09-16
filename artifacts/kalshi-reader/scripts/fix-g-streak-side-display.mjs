import fs from 'node:fs';

const file = 'artifacts/kalshi-reader/public/operations-core.js';
let source = fs.readFileSync(file, 'utf8');

const before = `  const sideOf = (o) => {
    const c = clientId(o); if (c.startsWith('eth-yes-')) return 'YES'; if (c.startsWith('eth-no-')) return 'NO';
    const s = String(first(o, ['side','order_side']) ?? '').toLowerCase();
    if (s === 'yes' || s === 'bid') return 'YES'; if (s === 'no' || s === 'ask') return 'NO'; return '—';
  };`;

const after = `  const sideOf = (o) => {
    const c = clientId(o); if (c.startsWith('eth-yes-')) return 'YES'; if (c.startsWith('eth-no-')) return 'NO';
    const s = String(first(o, ['side','order_side']) ?? '').toLowerCase();
    if (c.startsWith('g-streak-reversal-v1:')) {
      const action = String(first(o, ['action','order_action']) ?? '').toLowerCase();
      if (s === 'ask') return 'NO';
      if (s === 'bid') return 'YES';
      if (s === 'yes' && action === 'sell') return 'NO';
      if (s === 'yes' && action === 'buy') return 'YES';
      if (s === 'no' && action === 'sell') return 'YES';
      if (s === 'no' && action === 'buy') return 'NO';
    }
    if (s === 'yes' || s === 'bid') return 'YES'; if (s === 'no' || s === 'ask') return 'NO'; return '—';
  };`;

if (source.includes(after)) {
  console.log('G streak side display fix already applied');
  process.exit(0);
}
if (!source.includes(before)) throw new Error('operations sideOf anchor not found');
source = source.replace(before, after);
fs.writeFileSync(file, source);
console.log('Applied G streak reversal display-side fix');
