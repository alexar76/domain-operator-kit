import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, DomainService, demoProvider, demoPayments, signer, createHttpServer } from '../src/index.js';
import { DomainClient } from '../src/client.js';
import { ownerHeaders, digest, canonical, verifySignature } from '../src/core.js';
import { inspectPayment, termsFor } from '../src/payments.js';

const contact = { first_name: 'Test', last_name: 'Owner', email: 'owner@example.net', phone_country: '+1', phone_number: '5551234567', street: 'Street', number: '1', city: 'City', postal_code: '12345', country: 'US' };
async function fixture({ paid = false } = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 8)), owner = signer(), seller = signer();
  const payments = demoPayments(); let settlements = 0, verifications = 0;
  if (paid) Object.assign(payments, { kind: 'x402', payTo: `0x${'12'.repeat(20)}`, terms: amount => termsFor(amount, payments.payTo), inspect: inspectPayment,
    verifyOrder: async () => {}, verify: async () => { verifications++; }, settle: async () => { settlements++; return { transaction: `0x${'ab'.repeat(32)}` }; } });
  const provider = demoProvider(store); provider.sandbox = !paid;
  const service = new DomainService({ store, provider, payments, signer: seller, origin: 'http://127.0.0.1', mode: paid ? 'live' : 'demo', termsUrl: 'https://seller.example/terms' });
  if (paid) provider.kind = 'fixture';
  const server = createHttpServer(service, { requestsPerMinute: 1000 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`; service.origin = url;
  return { store, service, owner, seller, url, counts: () => ({ settlements, verifications }),
    async post(path, input, headers = {}) { const response = await fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(input) }); return { response, body: await response.json() }; },
    async close() { await new Promise(resolve => server.close(resolve)); store.close(); } };
}

test('HTTP purchase to DNS lifecycle verifies seller signatures and protects replayed owner requests', async () => {
  const f = await fixture(); try {
    const client = new DomainClient({ url: f.url, sellerKey: f.seller.publicKey, productId: 'domains-operator', ownerKey: f.owner, allowLocal: true, allowDemo: true, maxPurchaseUsd: '20.00' });
    const q = await client.call('quote', { domain: 'sample.com' });
    const input = { quote_id: q.quote_id, client_order_id: 'test-order-123456789', accept_terms: true, terms_version: '1', registrant: contact };
    const headers = ownerHeaders(f.owner, f.url, '/register', input);
    const first = await f.post('/register', input, headers); assert.equal(first.response.status, 200); assert.equal(first.body.result.status, 'delivered');
    const replay = await f.post('/register', input, headers); assert.equal(replay.response.status, 409); assert.equal(replay.body.error, 'request_replayed');
    const recovered = await client.call('register', input); assert.equal(recovered.order_id, first.body.result.order_id);
    assert.equal((await client.call('info', { domain: 'sample.com' })).domain, 'sample.com');
    const wrong = await f.post('/info', { domain: 'sample.com' }, ownerHeaders(signer(), f.url, '/info', { domain: 'sample.com' })); assert.equal(wrong.response.status, 404);
    const dns = await client.call('dnsGet', { domain: 'sample.com' });
    const changed = await client.call('dnsSet', { domain: 'sample.com', revision: dns.revision, records: [{ name: 'www.sample.com', type: 'CNAME', value: 'target.vercel.app', ttl: 300 }] });
    assert.equal(changed.records[0].value, 'target.vercel.app');
    const index = await (await fetch(`${f.url}/listing.json`)).json(); assert.equal(index.listings.length, 1); assert.equal(index.listings[0].capability_id, 'domains.quote@v1');
  } finally { await f.close(); }
});

test('owner signatures bind seller, exact route and body; public hub route refuses private renewal', async () => {
  const f = await fixture(); try {
    const input = { domain: 'sample.com' };
    const bad = await f.post('/info', input, ownerHeaders(f.owner, 'https://other.example', '/info', input)); assert.equal(bad.response.status, 401);
    const badPath = await f.post('/info', input, ownerHeaders(f.owner, f.url, '/dns/get', input)); assert.equal(badPath.response.status, 401);
    const stale = await f.post('/info', input, ownerHeaders(f.owner, f.url, '/info', input, Date.now() - 400000)); assert.equal(stale.response.status, 401);
    const privateCall = await f.post('/quote/invoke', { input: { domain: 'sample.com', operation: 'renew' } }); assert.equal(privateCall.response.status, 403);
    const quote = await f.post('/quote/invoke', { input }); assert.equal(quote.response.status, 200);
    assert.ok(verifySignature(f.seller.publicKey, canonical({ capability_id: 'domains.quote@v1', product_id: 'domains-operator', input_sha256: digest(input), result: quote.body.result }), quote.response.headers.get('x-provider-signature')));
  } finally { await f.close(); }
});

function payload(terms) { return { x402Version: 2, accepted: terms, payload: { signature: `0x${'11'.repeat(65)}`, authorization: {
  from: `0x${'34'.repeat(20)}`, to: terms.payTo, value: terms.amount, nonce: `0x${'56'.repeat(32)}`,
  validAfter: String(Math.floor(Date.now() / 1000) - 1), validBefore: String(Math.floor(Date.now() / 1000) + 299) } } }; }

test('paid client receives signed 402, reserves daily budget and reuses original payment on retries', async () => {
  const f = await fixture({ paid: true }); const ledger = new Store(':memory:', Buffer.alloc(32, 5)); let signed = 0;
  try {
    const client = new DomainClient({ url: f.url, sellerKey: f.seller.publicKey, productId: 'domains-operator', ownerKey: f.owner,
      allowLocal: true, store: ledger, maxPurchaseUsd: '20.00', dailyBudgetUsd: '20.00', paymentSigner: async requirements => { signed++; return payload(requirements.accepts[0]); } });
    const q = await client.call('quote', { domain: 'sample.com' });
    const input = { quote_id: q.quote_id, client_order_id: 'paid-order-123456789', accept_terms: true, terms_version: '1', registrant: contact };
    const result = await client.call('register', input); assert.equal(result.status, 'delivered');
    assert.equal((await client.call('register', input)).order_id, result.order_id); assert.equal(signed, 1); assert.equal(f.counts().settlements, 1);
    const q2 = await client.call('quote', { domain: 'sample2.com' });
    await assert.rejects(client.call('register', { ...input, quote_id: q2.quote_id, client_order_id: 'paid-second-order-12345' }), { code: 'buyer_daily_budget_exceeded' });
    assert.equal(f.counts().settlements, 1);
  } finally { ledger.close(); await f.close(); }
});

test('malformed/wrong-chain payment cannot reach the facilitator or registrar', async () => {
  const f = await fixture({ paid: true }); try {
    const q = await f.service.quote({ domain: 'sample.com' });
    const input = { quote_id: q.quote_id, client_order_id: 'bad-payment-order-12345', accept_terms: true, terms_version: '1', registrant: contact };
    const p = payload(termsFor(q.price_usd, f.service.payments.payTo)); p.accepted.network = 'eip155:1';
    const headers = { ...ownerHeaders(f.owner, f.url, '/register', input), 'payment-signature': Buffer.from(JSON.stringify(p)).toString('base64') };
    const r = await f.post('/register', input, headers); assert.equal(r.response.status, 402); assert.equal(r.body.error, 'payment_terms_mismatch');
    assert.deepEqual(f.counts(), { settlements: 0, verifications: 0 });
  } finally { await f.close(); }
});

test('pinned client rejects a different seller key and defaults to purchases disabled', async () => {
  const f = await fixture(); try {
    const c = new DomainClient({ url: f.url, sellerKey: signer().publicKey, productId: 'domains-operator', ownerKey: f.owner, allowLocal: true, allowDemo: true });
    await assert.rejects(c.call('quote', { domain: 'sample.com' }), { code: 'invalid_seller_signature' });
    await assert.rejects(c.call('register', {}), { code: 'purchases_disabled' });
  } finally { await f.close(); }
});
