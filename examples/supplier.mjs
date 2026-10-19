// Runnable HTTP supplier contract example. It only simulates domains and payments.
// Production suppliers replace demoProvider with their own durable registrar integration.
import { createServer } from 'node:http';
import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Store, demoProvider } from '../src/index.js';
import { canonical, digest, units } from '../src/core.js';

const secret = readFileSync(process.env.DOMAIN_SUPPLIER_SECRET_FILE, 'utf8').trim();
if (secret.length < 32) throw Error('HMAC secret requires 32+ characters');
const dir = resolve(process.env.DOMAIN_SUPPLIER_DATA_DIR || './data/example-supplier'); mkdirSync(dir, { recursive: true, mode: 0o700 });
const keyPath = join(dir, 'encryption.key');
if (!existsSync(keyPath)) writeFileSync(keyPath, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
const store = new Store(join(dir, 'supplier.sqlite'), Buffer.from(readFileSync(keyPath, 'utf8').trim(), 'hex')), provider = demoProvider(store);
const server = createServer(async (req, res) => {
  const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  try {
    if (req.method !== 'POST' || !['/quote', '/prepare', '/submit', '/reconcile', '/info', '/dns/get', '/dns/set'].includes(req.url)) return send(404, { error: 'not_found' });
    let size = 0; const chunks = [];
    for await (const chunk of req) { size += chunk.length; if (size > 32768) return send(413, { error: 'body_too_large' }); chunks.push(chunk); }
    const body = JSON.parse(Buffer.concat(chunks).toString()), time = req.headers['x-kit-time'], signature = req.headers['x-kit-signature'];
    const expected = createHmac('sha256', secret).update(`${time}.POST.${req.url}.${canonical(body)}`).digest('hex');
    if (!/^\d{13}$/.test(time || '') || Math.abs(Date.now() - Number(time)) > 300000 || !/^[a-f0-9]{64}$/.test(signature || '')
      || !timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) return send(401, { error: 'unauthorized', definite_failure: true });
    const mutating = ['/prepare', '/submit', '/dns/set'].includes(req.url);
    if (mutating && !store.consumeNonce(digest(`${time}:${signature}`), Date.now())) return send(409, { error: 'request_replayed' });
    let result;
    if (req.url === '/dns/set') result = await provider.dnsSet(body.domain, body.records, body.revision);
    else {
      const name = { '/quote': 'quote', '/prepare': 'prepare', '/submit': 'submit', '/reconcile': 'reconcile', '/info': 'info', '/dns/get': 'dnsGet' }[req.url];
      if (name === 'submit') {
        const price = await provider.quote(body);
        if (units(price.cost_usd) > units(body.max_cost_usd)) return send(422, { error: 'price_changed', definite_failure: true });
      }
      result = await provider[name](body);
    }
    send(200, result);
  } catch { send(500, { error: 'supplier_outcome_unknown' }); }
});
server.requestTimeout = 30000;
server.listen(Number(process.env.DOMAIN_SUPPLIER_PORT || 9496), '127.0.0.1', () => console.error(`DEMO supplier only; no real domains. port=${server.address().port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(() => store.close()));
