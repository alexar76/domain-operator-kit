import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, DomainService, demoProvider, demoPayments, signer, createHttpServer, rdapAvailability, liveReadiness, configuredService, nodeToml, listing } from '../src/index.js';
import { ownerHeaders } from '../src/core.js';

// A public demo seller: real availability, signed illustrative quotes, every read answers; buying is refused.
async function publicDemo(registered = new Set(['taken.com'])) {
  const store = new Store(':memory:', Buffer.alloc(32, 9)), seller = signer();
  const availability = async domain => !registered.has(domain);
  const service = new DomainService({ store, provider: demoProvider(store, { availability }), payments: demoPayments(), signer: seller,
    origin: 'http://127.0.0.1', termsUrl: 'https://example.invalid/demo-terms', demoOrders: false, liveMissing: ['PAY_TO'] });
  const server = createHttpServer(service, { requestsPerMinute: 1000 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`; service.origin = url;
  const post = async (path, input, headers = {}) => {
    const response = await fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(input) });
    return { status: response.status, body: await response.json() };
  };
  return { service, url, post, close: async () => { await new Promise(r => server.close(r)); store.close(); } };
}

test('public demo: real availability and signed quotes, but register and renew answer demo_mode', async () => {
  const f = await publicDemo(); try {
    const taken = await f.post('/quote', { domain: 'taken.com' });
    assert.equal(taken.status, 200); assert.equal(taken.body.result.available, false);
    const free = await f.post('/quote', { domain: 'free-name.com' });
    assert.equal(free.body.result.available, true);
    assert.equal(free.body.result.mode, 'demo');
    assert.deepEqual(free.body.result.demo, { orders: 'refused with demo_mode', prices: 'illustrative', availability: 'rdap' });
    // Through the Hub's wrapped route too.
    const wrapped = await f.post('/quote/invoke', { capability_id: 'domains.quote@v1', input: { domain: 'free-name.com' } });
    assert.equal(wrapped.body.result.available, true);
    // No owner key needed to learn why buying is refused.
    for (const path of ['/register', '/renew']) {
      const r = await f.post(path, { quote_id: free.body.result.quote_id });
      assert.equal(r.status, 403, path); assert.equal(r.body.error, 'demo_mode', path);
    }
    // With an owner key the service refuses too, and nothing is recorded.
    const owner = signer();
    const input = { quote_id: free.body.result.quote_id, client_order_id: 'demo-order-1234567890', accept_terms: true, terms_version: '1' };
    const signed = await f.post('/register', input, ownerHeaders(owner, f.url, '/register', input));
    assert.equal(signed.body.error, 'demo_mode');
    assert.equal(f.service.store.all('orders').length, 0);
    // Reads still answer: an unknown owner simply owns nothing.
    const info = await f.post('/info', { domain: 'free-name.com' }, ownerHeaders(owner, f.url, '/info', { domain: 'free-name.com' }));
    assert.equal(info.status, 404); assert.equal(info.body.error, 'domain_not_found');
    const health = await (await fetch(`${f.url}/healthz`)).json();
    assert.equal(health.orders, 'refused_demo'); assert.deepEqual(health.live_missing, ['PAY_TO']);
    const l = listing(f.service);
    assert.match(l.listings[0].description, /^DEMO SELLER: real availability \(registry RDAP\), illustrative prices; orders are refused with demo_mode\./);
    assert.match(nodeToml(f.service, 'https://domains.example'), /DEMO SELLER/);
    // A hub's sandbox probe fills required fields from examples; a placeholder is not a domain.
    assert.match(nodeToml(f.service, 'https://domains.example'), /examples = \["example\.com"\]/);
  } finally { await f.close(); }
});

test('RDAP: 404 is free, 200 is taken, anything else is unknown rather than a guess', async () => {
  const seen = [];
  const answer = status => rdapAvailability({ fetchImpl: async url => { seen.push(url); return new Response('{}', { status }); } });
  assert.equal(await answer(404)('free-name.com'), true);
  assert.equal(await answer(200)('taken.net'), false);
  await assert.rejects(answer(503)('maybe.org'), e => e.code === 'availability_unknown');
  await assert.rejects(rdapAvailability({ fetchImpl: async () => { throw Error('offline'); } })('x.com'), e => e.code === 'availability_unknown');
  assert.deepEqual(seen, ['https://rdap.verisign.com/com/v1/domain/free-name.com', 'https://rdap.verisign.com/net/v1/domain/taken.net',
    'https://rdap.publicinterestregistry.org/rdap/domain/maybe.org']);
});

test('auto mode: a demo until every live setting is in; it names what is missing, never a value', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'domain-auto-'));
  try {
    const empty = liveReadiness({});
    assert.deepEqual(empty.missing, ['OPENPROVIDER_USERNAME_FILE or DOMAIN_SUPPLIER_URL', 'PAY_TO', 'CDP_KEY_FILE', 'DOMAIN_REFUND_KEY_FILE',
      'DOMAIN_PUBLIC_URL', 'DOMAIN_TERMS_URL', 'DOMAIN_UPSTREAM_COST_CONFIRMED']);
    const file = (name, text) => { const p = join(dir, name); writeFileSync(p, text, { mode: 0o600 }); return p; };
    const env = { OPENPROVIDER_USERNAME_FILE: file('u', 'user'), OPENPROVIDER_PASSWORD_FILE: file('p', 'secret-value'),
      PAY_TO: `0x${'ab'.repeat(20)}`, CDP_KEY_FILE: file('c', '{}'), DOMAIN_REFUND_KEY_FILE: file('r', 'ff'),
      DOMAIN_PUBLIC_URL: 'https://domains.example', DOMAIN_TERMS_URL: 'https://seller.example/terms', DOMAIN_UPSTREAM_COST_CONFIRMED: '1' };
    assert.deepEqual(liveReadiness(env), { provider: 'openprovider', missing: [] });
    const half = liveReadiness({ ...env, OPENPROVIDER_PASSWORD_FILE: join(dir, 'absent'), DOMAIN_UPSTREAM_COST_CONFIRMED: '' });
    assert.deepEqual(half.missing, ['OPENPROVIDER_PASSWORD_FILE', 'DOMAIN_UPSTREAM_COST_CONFIRMED']);
    assert.ok(!JSON.stringify(half).includes('secret-value'));
    assert.deepEqual(liveReadiness({ ...env, DOMAIN_PROVIDER: 'porkbun' }).missing, ['DOMAIN_PROVIDER (porkbun is sandbox-only)']);

    // Keys half in: the node stays a public demo with the demo provider, refusing orders.
    const service = await configuredService({ ...env, DOMAIN_MODE: 'auto', DOMAIN_UPSTREAM_COST_CONFIRMED: '', DOMAIN_DATA_DIR: join(dir, 'data') });
    try {
      assert.equal(service.mode, 'demo'); assert.equal(service.provider.kind, 'demo'); assert.equal(service.provider.availability, 'rdap');
      assert.equal(service.refusesOrders, true); assert.deepEqual(service.liveMissing, ['DOMAIN_UPSTREAM_COST_CONFIRMED']);
    } finally { service.store.close(); }
    // The local demo keeps simulating whole purchases.
    const local = await configuredService({ DOMAIN_DATA_DIR: join(dir, 'local') });
    try { assert.equal(local.refusesOrders, false); assert.equal(local.provider.availability, 'simulated'); } finally { local.store.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
