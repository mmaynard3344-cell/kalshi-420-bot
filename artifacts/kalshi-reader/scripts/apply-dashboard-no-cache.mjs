import fs from 'node:fs';

const serverPath = new URL('../server.mjs', import.meta.url);
let server = fs.readFileSync(serverPath, 'utf8');
const oldCache = "    'cache-control': filePath.endsWith('index.html') ? 'no-store' : 'public, max-age=31536000, immutable',";
const newCache = "    'cache-control': (filePath.endsWith('.html') || filePath.endsWith('.js')) ? 'no-store' : 'public, max-age=31536000, immutable',";
if (!server.includes(newCache)) {
  if (!server.includes(oldCache)) throw new Error('dashboard no-cache: server cache anchor not found');
  server = server.replace(oldCache, newCache);
}
fs.writeFileSync(serverPath, server);

const dashboardPath = new URL('../public/eth420-dashboard.html', import.meta.url);
let html = fs.readFileSync(dashboardPath, 'utf8');
html = html.replace('<script defer src="/pnl-runtime.js"></script>', '<script defer src="/pnl-runtime.js?v=ops-audit-v3"></script>');
fs.writeFileSync(dashboardPath, html);
