import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openprovider, httpProvider } from '../src/providers.js';
import { Store } from '../src/store.js';

const ok = data => new Response(JSON.stringify({ code: 0, data }), { status: 200 });
function fixture() {
  const calls = [], store = new Store(':memory:', Buffer.alloc(32, 13)); let row = null, price = '10.00', premium = false, currency = 'USD', failPost = false;
  let records = [{ name: '', type: 'MX', value: 'mail.example.net', ttl: 900, prio: 10 }, { name: 'www', type: 'A', value: '192.0.2.1', ttl: 900 }];
  const fetchImpl = async (url, options) => {
    const u = new URL(url); const b = options.body ? JSON.parse(options.body) : null; calls.push({ path: u.pathname, search: u.searchParams, method: options.method, body: b });
    assert.equal(options.redirect, 'error');
    if (u.pathname.endsWith('/auth/login')) return ok({ token: 'private-token' });
    assert.equal(options.headers.authorization, 'Bearer private-token');
    if (u.pathname.endsWith('/domains/check')) return ok({ results: [{ domain: 'sample.com', status: row ? 'active' : 'free', is_premium: premium }] });
    if (u.pathname.endsWith('/domains/prices')) return ok({ is_premium: premium, price: { reseller: { currency, price } } });
    if (u.pathname.endsWith('/customers')) return ok({ handle: 'BUYER-HANDLE' });
    if (u.pathname.endsWith('/domains') && options.method === 'POST') {
      row = { id: 17, domain: b.domain, status: 'ACT', comments: b.comments, owner_handle: b.owner_handle, expiration_date: '2028-01-01T00:00:00Z', name_servers: [{ name: 'ns1.example.org' }], verification_email_status: 'not verified' };
      if (failPost) throw Error('timeout after commit'); return ok(row);
    }
    if (u.pathname.endsWith('/domains/17/renew')) { row.expiration_date = '2029-01-01T00:00:00Z'; if (failPost) throw Error('unknown renewal'); return ok({ status: 'ACT' }); }
    if (u.pathname.endsWith('/domains') && options.method === 'GET') return ok({ results: row ? [row] : [], total: row ? 1 : 0 });
    if (u.pathname.endsWith('/domains/17')) return ok(row);
    if (u.pathname.endsWith('/dns/zones/sample.com')) {
      if (options.method === 'PUT') {
        const same = (r, old) => old.name === r.name && old.type === r.type && old.value === r.value;
        records = records.map(r => (b.records.update || []).find(u => same(r, u.original_record))?.record || r);
        records = [...records.filter(r => !b.records.remove.some(old => same(r, old))), ...b.records.add];
        return ok({ success: true });
      }
      return ok({ records });
    }
    throw Error(`unexpected call ${u.pathname}`);
  };
  const provider = openprovider({ username: 'user', password: 'secret', fetchImpl, store });
  const order = { id: 'stable-order', operation: 'register', domain: 'sample.com', prepared: { customer_handle: 'BUYER-HANDLE' } };
  return { calls, provider, order, store, setPrice(v) { price = v; }, setPremium() { premium = true; }, setCurrency(v) { currency = v; }, setFailure(v) { failPost = v; }, row: () => row };
}

test('Openprovider maps published REST fields, refuses premium/non-USD and uses actual operation prices', async () => {
  const f = fixture(); try {
    const q = await f.provider.quote({ domain: 'sample.com', operation: 'register' }); assert.equal(q.cost_usd, '10.000000');
    assert.deepEqual(f.calls.filter(c => c.path.endsWith('/prices')).map(c => c.search.get('operation')), ['create', 'renew']);
    f.setCurrency('EUR'); await assert.rejects(f.provider.quote({ domain: 'sample.com', operation: 'register' }), { code: 'supplier_currency_not_usd' });
    f.setPremium(); await assert.rejects(f.provider.quote({ domain: 'sample.com', operation: 'register' }), { code: 'premium_not_supported' });
  } finally { f.store.close(); }
});

test('Openprovider registers to buyer, disables paid extras/autorenew and recovers unknown submission by evidence', async () => {
  const f = fixture(); try {
    f.setFailure(true); await assert.rejects(f.provider.submit(f.order));
    const r = await f.provider.reconcile(f.order); assert.equal(r.status, 'delivered'); assert.equal(r.domain.action_required, 'verify_registrant_email');
    const post = f.calls.find(c => c.path.endsWith('/domains') && c.method === 'POST').body;
    assert.equal(post.owner_handle, 'BUYER-HANDLE'); assert.equal(post.autorenew, 'off'); assert.equal(post.accept_premium_fee, 0); assert.equal(post.is_sectigo_dns_enabled, false);
    f.row().comments = 'other-order'; assert.equal((await f.provider.reconcile(f.order)).status, 'pending');
    f.row().comments = `domain-kit:${f.order.id}`; f.row().owner_handle = 'OTHER'; assert.equal((await f.provider.reconcile(f.order)).status, 'pending');
    assert.equal(f.calls.filter(c => c.path.endsWith('/domains') && c.method === 'POST').length, 1);
  } finally { f.store.close(); }
});

test('acknowledged renewal can deliver, but expiry alone never proves an ambiguous renewal', async () => {
  const f = fixture(); try {
    await f.provider.submit(f.order);
    const renewal = { ...f.order, id: 'renewal-1', operation: 'renew', provider_domain_id: '17', before_expiry: f.row().expiration_date };
    const r = await f.provider.submit(renewal); assert.equal(r.status, 'delivered');
    f.setFailure(true);
    const unknown = { ...renewal, id: 'renewal-2', before_expiry: '2028-01-01T00:00:00Z' };
    await assert.rejects(f.provider.submit(unknown)); assert.equal((await f.provider.reconcile(unknown)).status, 'pending');
  } finally { f.store.close(); }
});

test('HTTP provider sends only supplier data and no payment authorization or owner identity', async () => {
  let received;
  const provider = httpProvider({ url: 'https://supplier.example', secret: 's'.repeat(32), tlds: ['com'], fetchImpl: async (_url, options) => {
    received = JSON.parse(options.body); assert.ok(options.headers['x-kit-signature']); assert.equal(options.redirect, 'error'); return new Response(JSON.stringify({ status: 'pending' }));
  } });
  await provider.submit({ id: 'order', domain: 'sample.com', operation: 'register', prepared: { customer_handle: 'customer' }, quote: { cost_usd: '10.00' }, payment: { payload: 'secret-payment' }, owner: 'private-owner', registrant: { email: 'private-email' } });
  assert.equal(received.max_cost_usd, '10.00'); assert.ok(!JSON.stringify(received).includes('private')); assert.ok(!('payment' in received));
});

test('Openprovider DNS converts full names to relative labels and preserves unrelated record sets', async () => {
  const f = fixture(); try {
    await f.provider.submit(f.order);
    const record = { domain: 'sample.com', provider_domain_id: '17', prepared: f.order.prepared };
    const before = await f.provider.dnsGet(record); assert.equal(before.records[0].name, 'sample.com'); assert.equal(before.records[1].name, 'www.sample.com');
    const after = await f.provider.dnsSet(record, [{ name: 'www.sample.com', type: 'A', value: '192.0.2.2', ttl: 900, prio: 0 }], before.revision);
    assert.ok(after.records.some(r => r.type === 'MX' && r.value === 'mail.example.net'));
    assert.equal(after.records.find(r => r.type === 'A').value, '192.0.2.2');
    const write = f.calls.find(c => c.method === 'PUT').body; assert.equal(write.records.update[0].record.name, 'www'); assert.equal(write.records.update[0].original_record.name, 'www');
    assert.equal(f.calls[0].path, '/v1beta/auth/login');
    await assert.rejects(f.provider.dnsSet(record, [{ name: 'sample.com', type: 'A', value: '192.0.2.2', ttl: 300 }], after.revision), { code: 'registrar_ttl_requires_900_3600_10800_21600_43200_86400' });
  } finally { f.store.close(); }
});

test('HTTP provider treats malformed replies and timeouts as ambiguous, not definite refusals', async () => {
  for (const fetchImpl of [async () => { throw Error('timeout'); }, async () => new Response('gateway error', { status: 502 })]) {
    const p = httpProvider({ url: 'https://supplier.example', secret: 's'.repeat(32), tlds: ['com'], fetchImpl });
    await assert.rejects(p.submit({ quote: { cost_usd: '1.00' } }), error => error.definite === false);
  }
});

// Mirrors the real sandbox response: availability omits the flag; operation
// prices explicitly include it. Fixtures with false everywhere hid this bug.
function quoteFixture({ availability = {}, create = { is_premium: false }, renew = { is_premium: false } } = {}) {
  const calls = [];
  const provider = openprovider({ username: 'user', password: 'secret', fetchImpl: async (url, options) => {
    const u = new URL(url); calls.push(u.pathname);
    if (u.pathname.endsWith('/auth/login')) return ok({ token: 'private-token' });
    if (u.pathname.endsWith('/domains/check')) return ok({ results: [{ domain: 'sample.com', status: 'free',
      price: { reseller: { currency: 'USD', price: 11.98 } }, ...availability }] });
    if (u.pathname.endsWith('/domains/prices')) {
      const renewing = u.searchParams.get('operation') === 'renew';
      return ok({ price: { reseller: { currency: 'USD', price: renewing ? 16.98 : 11.98 } }, ...(renewing ? renew : create) });
    }
    assert.fail(`unexpected request: ${options.method} ${u.pathname}`);
  } });
  return { provider, calls };
}

test('Openprovider accepts omitted availability premium flag only with explicit non-premium operation prices', async () => {
  const { provider, calls } = quoteFixture();
  assert.deepEqual(await provider.quote({ domain: 'sample.com', operation: 'register' }), {
    available: true, cost_usd: '11.980000', renewal_cost_usd: '16.980000', currency: 'USD', premium: false, period_years: 1,
  });
  assert.equal(calls.filter(p => p.endsWith('/domains/prices')).length, 2);
});

test('Openprovider distinguishes premium, claims and malformed availability without checking prices', async () => {
  const cases = [
    [{ is_premium: true }, 'premium_not_supported'],
    [{ claim_key: 'registry-claim' }, 'domain_claim_not_supported'],
    [{ is_premium: null }, 'registrar_premium_status_unknown'],
    [{ is_premium: 'false' }, 'registrar_premium_status_unknown'],
    [{ is_premium: 0 }, 'registrar_premium_status_unknown'],
    [{ premium: { price: { create: 250 } } }, 'registrar_premium_status_unknown'],
  ];
  for (const [availability, code] of cases) {
    const { provider, calls } = quoteFixture({ availability });
    await assert.rejects(provider.quote({ domain: 'sample.com', operation: 'register' }), { code });
    assert.equal(calls.filter(p => p.endsWith('/domains/prices')).length, 0);
  }
});

test('Openprovider refuses premium or ambiguous create/renew pricing even when availability says ordinary', async () => {
  for (const field of ['create', 'renew']) {
    for (const [value, code] of [
      [{ is_premium: true }, 'premium_not_supported'],
      [{}, 'registrar_premium_status_unknown'],
      [{ is_premium: null }, 'registrar_premium_status_unknown'],
      [{ is_premium: 'false' }, 'registrar_premium_status_unknown'],
    ]) {
      const { provider } = quoteFixture({ availability: { is_premium: false }, [field]: value });
      await assert.rejects(provider.quote({ domain: 'sample.com', operation: 'register' }), { code });
    }
  }
  const { provider } = quoteFixture({ renew: {} });
  await assert.rejects(provider.quote({ domain: 'sample.com', operation: 'renew' }), { code: 'registrar_premium_status_unknown' });
});


test('supplier reads retry transient failures once, while mutations are never replayed', async () => {
  for (const failure of [() => { throw Error('timeout'); }, () => new Response('upstream unavailable', { status: 503 })]) {
    let reads = 0;
    const provider = httpProvider({ url: 'https://supplier.example', secret: 's'.repeat(32), tlds: ['com'], fetchImpl: async () => {
      if (++reads === 1) return failure();
      return new Response(JSON.stringify({ available: true }));
    } });
    assert.deepEqual(await provider.quote({ domain: 'sample.com' }), { available: true }); assert.equal(reads, 2);
    let mutations = 0;
    const writer = httpProvider({ url: 'https://supplier.example', secret: 's'.repeat(32), tlds: ['com'], fetchImpl: async () => {
      mutations++; return failure();
    } });
    await assert.rejects(writer.submit({ quote: { cost_usd: '1.00' } }), e => e.definite === false);
    assert.equal(mutations, 1);
  }
});

test('supplier read retries are bounded and do not retry authentication refusals', async () => {
  let attempts = 0;
  const make = fetchImpl => httpProvider({ url: 'https://supplier.example', secret: 's'.repeat(32), tlds: ['com'], fetchImpl });
  await assert.rejects(make(async () => { attempts++; throw Error('timeout'); }).quote({}), { code: 'supplier_read_failed' });
  assert.equal(attempts, 2); attempts = 0;
  await assert.rejects(make(async () => { attempts++; return new Response('{}', { status: 401 }); }).quote({}), { code: 'supplier_unavailable' });
  assert.equal(attempts, 1);
});


test('Openprovider DNS is idempotent for quoted TXT and sends only actual RRset changes', async () => {
  const f = fixture(); try {
    await f.provider.submit(f.order);
    const record = { domain: 'sample.com', provider_domain_id: '17', prepared: f.order.prepared };
    let dns = await f.provider.dnsGet(record);
    const txt = { name: '_verify.sample.com', type: 'TXT', value: 'verify-token', ttl: 900, prio: 0 };
    dns = await f.provider.dnsSet(record, [txt], dns.revision);
    assert.equal(dns.records.find(r => r.type === 'TXT').value, 'verify-token');
    await assert.rejects(f.provider.dnsSet(record, [txt, { ...txt, value: '"verify-token"' }], dns.revision), { code: 'duplicate_dns_record' });
    let writes = f.calls.filter(c => c.method === 'PUT').length;
    dns = await f.provider.dnsSet(record, [{ ...txt, value: '"verify-token"' }], dns.revision);
    assert.equal(f.calls.filter(c => c.method === 'PUT').length, writes);
    dns = await f.provider.dnsSet(record, [txt, { ...txt, value: 'second-token' }], dns.revision);
    const addition = f.calls.filter(c => c.method === 'PUT').at(-1).body.records;
    assert.equal(addition.add.length, 1); assert.equal(addition.remove.length, 0); assert.equal(addition.update.length, 0);
    dns = await f.provider.dnsSet(record, [{ ...txt, ttl: 3600 }, { ...txt, value: 'second-token' }], dns.revision);
    const change = f.calls.filter(c => c.method === 'PUT').at(-1).body.records;
    assert.equal(change.add.length, 0); assert.equal(change.remove.length, 0); assert.equal(change.update.length, 1);
    assert.equal(change.update[0].original_record.value, '"verify-token"'); assert.equal(change.update[0].record.ttl, 3600);
    assert.ok(dns.records.some(r => r.type === 'MX' && r.value === 'mail.example.net'));
    writes = f.calls.filter(c => c.method === 'PUT').length;
    await assert.rejects(f.provider.dnsSet(record, [txt], 'stale-revision'), { code: 'dns_revision_changed' });
    assert.equal(f.calls.filter(c => c.method === 'PUT').length, writes);
  } finally { f.store.close(); }
});
