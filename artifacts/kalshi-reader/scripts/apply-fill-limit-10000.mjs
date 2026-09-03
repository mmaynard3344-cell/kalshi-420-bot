import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const operatorPath = join(here, '..', 'src', 'pages', 'Operator.tsx');
let source = readFileSync(operatorPath, 'utf8');

source = source.replaceAll('/api/trade/fills?limit=1000', '/api/trade/fills?limit=10000');
source = source.replaceAll('fills.length >= 1000', 'fills.length >= 10000');
source = source.replaceAll('The 1,000-fill exchange limit', 'The 10,000-fill exchange limit');

writeFileSync(operatorPath, source);
