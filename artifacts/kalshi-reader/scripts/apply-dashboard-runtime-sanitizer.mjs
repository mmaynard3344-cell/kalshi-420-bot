import fs from 'node:fs';

const path = new URL('../public/eth420-dashboard.html', import.meta.url);
let html = fs.readFileSync(path, 'utf8');

// Keep only the two external runtimes that own the live dashboard now:
// pnl-runtime.js and operations-core.js. Remove every accumulated inline
// dashboard runtime so malformed legacy scripts cannot execute or overwrite
// authoritative Operations fields.
html = html.replace(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/gi, '');

fs.writeFileSync(path, html);
