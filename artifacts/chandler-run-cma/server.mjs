import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const port = Number(process.env.PORT ?? 3000);
const root = join(fileURLToPath(new URL('.', import.meta.url)), 'public');
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/healthz') {
    res.writeHead(200, {'content-type':'text/plain; charset=utf-8','cache-control':'no-store'});
    res.end('ok');
    return;
  }

  let relative = decodeURIComponent(url.pathname);
  if (relative === '/') relative = '/index.html';
  relative = normalize(relative).replace(/^([.][.][/\\])+/, '');
  let filePath = join(root, relative);

  if (!filePath.startsWith(root) || !existsSync(filePath) || !statSync(filePath).isFile()) {
    filePath = join(root, 'index.html');
  }

  if (!existsSync(filePath)) {
    res.writeHead(404, {'content-type':'text/plain; charset=utf-8'});
    res.end('Not found');
    return;
  }

  res.writeHead(200, {
    'content-type': types[extname(filePath)] ?? 'application/octet-stream',
    'cache-control': filePath.endsWith('index.html') ? 'no-store' : 'public, max-age=300'
  });
  createReadStream(filePath).pipe(res);
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Chandler Run CMA dashboard listening on ${port}`);
});
