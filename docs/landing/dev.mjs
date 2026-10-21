// Local preview of the landing and the desk: node docs/landing/dev.mjs [port] [seller-url]
// Serves this folder as nginx does (same CSP) and forwards the seller routes (/quote, /register,
// /healthz, /listing.json, ...) to a seller node, by default modelmarket.dev's demo node.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2] || 8795);
const upstream = (process.argv[3] || 'https://domains.modelmarket.dev').replace(/\/+$/, '');
const SELLER = /^\/(quote|quote\/invoke|register|renew|status|info|dns\/get|dns\/set|transfer-code|listing\.json|healthz)$/;
const PAGES = { '/': 'index.html', '/desk/': 'desk/index.html' };
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
// The hash is the landing's import map (three.js from assets/vendor); test/landing.test.js keeps it current.
const CSP = "default-src 'self'; script-src 'self' 'sha256-Ar2H6vAaom3O3N7m8mcnoySPhQKmIAWL4HppxZWJ1vA='; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (SELLER.test(path)) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    try {
      const answer = await fetch(upstream + path, { method: req.method, headers: { 'content-type': req.headers['content-type'] || 'application/json' },
        body: req.method === 'POST' ? Buffer.concat(chunks) : undefined, signal: AbortSignal.timeout(30000) });
      res.writeHead(answer.status, { 'content-type': answer.headers.get('content-type') || 'application/json' });
      return res.end(Buffer.from(await answer.arrayBuffer()));
    } catch {
      res.writeHead(502, { 'content-type': 'application/json' });
      return res.end('{"success":false,"error":"upstream_unreachable"}');
    }
  }
  if (path === '/desk') { res.writeHead(301, { location: '/desk/' }); return res.end(); }
  const file = PAGES[path] || (/^\/assets\/(?:[\w-]+\/)*[\w.-]+\.(js|css)$/.test(path) ? path.slice(1) : null);
  if (!file) { res.writeHead(404); return res.end('not found'); }
  try {
    const body = await readFile(join(root, file));
    res.writeHead(200, { 'content-type': TYPES[extname(file)], 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      ...(file.endsWith('.html') ? { 'content-security-policy': CSP } : {}) });
    res.end(body);
  } catch { res.writeHead(404); res.end('not found'); }
}).listen(port, '127.0.0.1', () => console.log(`landing on http://127.0.0.1:${port}/ · seller routes → ${upstream}`));
