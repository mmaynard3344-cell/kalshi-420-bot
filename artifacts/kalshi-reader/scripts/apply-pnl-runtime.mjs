import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const dashboardPath = join(here, '..', 'public', 'eth420-dashboard.html');
let source = readFileSync(dashboardPath, 'utf8');

if (source.includes('pnl-runtime.js')) process.exit(0);
if (!source.includes('</head>')) throw new Error('pnl-runtime: closing head not found');
source = source.replace('</head>', '<script defer src="/pnl-runtime.js"></script>\n</head>');
writeFileSync(dashboardPath, source);
