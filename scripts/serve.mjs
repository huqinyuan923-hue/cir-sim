/**
 * 本地预览静态服务（npm run serve）：http://127.0.0.1:8080 → dist/
 */

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join } from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
};

const server = createServer((req, res) => {
  const url = (req.url ?? '/').split('?')[0];
  let file = url === '/' ? 'dist/index.html' : join('dist', url.replace(/^\/+/, ''));
  if (url === '/app.js') file = 'dist/app.js';
  if (!existsSync(file)) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
});

server.listen(8080, '127.0.0.1', () => {
  console.log('预览：http://127.0.0.1:8080');
});
