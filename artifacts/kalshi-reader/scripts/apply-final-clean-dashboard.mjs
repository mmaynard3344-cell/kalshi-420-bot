import { copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here=dirname(fileURLToPath(import.meta.url));
const pub=join(here,'..','public');
copyFileSync(join(pub,'eth420-dashboard.clean.html'),join(pub,'eth420-dashboard.html'));
copyFileSync(join(pub,'pnl-runtime.clean.js'),join(pub,'pnl-runtime.js'));
console.log('Applied final clean Shawshank dashboard template');
