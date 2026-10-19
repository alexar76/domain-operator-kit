import { test } from 'node:test';
import assert from 'node:assert/strict';
import { porkbun } from '../src/porkbun.js';
import { Store } from '../src/store.js';

const registrant = { first_name: 'Sandbox', last_name: 'Tester', email: 'sandbox@example.com', phone_country: '+1', phone_area: '202', phone_number: '5550100',
  street: 'Example Street', number: '1', city: 'Washington', state: 'DC', postal_code: '20001', country: 'US' };
function fixture() {
  const store = new Store(':memory:', Buffer.alloc(32, 73));
  const calls = [], replays = new Map(), receipts = [];
  let time = 1000, loss = '', sandbox = true, premium = 'no', duration = 1, preview = false, receiptCost = 1108;
  let readFailures = 0;
  let row = null, contact = null, serial = 1;
  let records = [{ id: '1', name: '_keep.sample.com', type: 'TXT', content: 'preserve', ttl: '900', prio: '0' }];
  const result = data => new Response(JSON.stringify({ status: 'SUCCESS', sandbox, ...data }));
  const fetchImpl = async (url, options) => {
    assert.equal(new URL(url).origin, 'https://api.porkbun.com'); assert.equal(options.redirect, 'error');
    const path = new URL(url).pathname.replace('/api/json/v3', ''), body = options.body && JSON.parse(options.body), key = options.headers['Idempotency-Key'];
    calls.push({ path, body, key });
    if (path.startsWith('/domain/getRegistrationRequirements') && readFailures-- > 0) return new Response('upstream unavailable', { status: 503 });
    if (key && replays.has(key)) {
      const previous = replays.get(key); assert.equal(JSON.stringify({ path, body }), previous.request); return result(previous.response);
    }
    let data = {};
    if (path === '/ping') return result({});
    if (path.startsWith('/domain/getRegistrationRequirements')) return result({ apiRegisterable: true, registrationDurationYears: 1, registryRequirements: null });
    if (path.startsWith('/domain/checkDomain')) return result({ response: { avail: row ? 'no' : 'yes', premium, minDuration: duration, type: 'registration', price: '11.08', additional: { renewal: { type: 'renewal', price: '11.08' } } } });
    if (path.startsWith('/domain/get/')) return result({ domain: row });
    if (path.startsWith('/domain/getContacts/')) return result({ contacts: { registrant: contact } });
    if (path.startsWith('/domain/getNs/')) return result({ ns: ['curitiba.ns.porkbun.com'] });
    if (path.startsWith('/dns/retrieve/')) return result({ records });
    assert.ok(key, 'every mutation must carry an idempotency key');
    if (path.startsWith('/domain/create/')) {
      row = { domain: 'sample.com', status: 'ACTIVE', expireDate: '2027-10-19', autoRenew: 1 };
      data = { domain: 'sample.com', orderId: 101, cost: receiptCost, ...(preview ? { dryRun: true } : {}) }; receipts.push(data);
    } else if (path.startsWith('/domain/renew/')) {
      row.expireDate = '2028-10-19'; data = { domain: 'sample.com', orderId: 102, cost: receiptCost }; receipts.push(data);
    } else if (path.startsWith('/domain/updateAutoRenew/')) row.autoRenew = 0;
    else if (path.startsWith('/domain/updateContacts/')) contact = body.contact;
    else if (path.startsWith('/dns/create/')) {
      const id = String(++serial); records.push({ id, name: body.name ? `${body.name}.sample.com` : 'sample.com', type: body.type, content: body.content, ttl: body.ttl, prio: body.prio }); data = { id };
    } else if (path.startsWith('/dns/edit/')) {
      const r = records.find(r => r.id === path.split('/').at(-1)); Object.assign(r, { content: body.content, ttl: body.ttl, prio: body.prio });
    } else if (path.startsWith('/dns/delete/')) records = records.filter(r => r.id !== path.split('/').at(-1));
    else assert.fail(`Unexpected endpoint ${path}`);
    replays.set(key, { request: JSON.stringify({ path, body }), response: data });
    if (loss && path.includes(loss)) { loss = ''; throw Error('lost response after commit'); }
    return result(data);
  };
  const make = () => porkbun({ apiKey: 'pk1_sb_1234', secretKey: 'sk1_sb_abcd', store, fetchImpl, now: () => time });
  const provider = make();
  return { store, calls, receipts, make, provider, row: () => row, contact: () => contact,
    setReadFailures(v) { readFailures = v; }, setLoss(v) { loss = v; }, advance(ms) { time += ms; }, setSandbox(v) { sandbox = v; }, setPremium(v) { premium = v; }, setDuration(v) { duration = v; }, setPreview() { preview = true; }, setReceiptCost(v) { receiptCost = v; },
    async order() { return { id: 'test-order', domain: 'sample.com', operation: 'register', quote: { cost_usd: '11.080000' }, prepared: await provider.prepare({ registrant }) }; },
    async record() { const order = await this.order(); await provider.submit(order); return { domain: order.domain, provider_domain_id: order.domain, prepared: order.prepared }; },
  };
}

test('Porkbun rejects live mode, wrong key types and changed account before sending requests', () => {
  const f = fixture(); try {
    assert.throws(() => porkbun({ sandbox: false }), /live mode/);
    assert.throws(() => porkbun({ apiKey: 'pk1_live', secretKey: 'sk1_live' }), /sandbox API key/);
    assert.throws(() => porkbun({ apiKey: 'pk1_sb_5678', secretKey: 'sk1_sb_abcd', store: f.store }), /account changed/);
    assert.equal(f.calls.length, 0);
  } finally { f.store.close(); }
});

test('Porkbun confirms sandbox before writes and rejects a missing sandbox marker', async () => {
  const f = fixture(); try {
    f.setSandbox(undefined);
    await assert.rejects(f.provider.submit(await f.order()), { code: 'porkbun_sandbox_not_confirmed' });
    assert.equal(f.receipts.length, 0);
  } finally { f.store.close(); }
});

test('Porkbun quotes exact USD costs and fails closed on premium/unknown status and multi-year terms', async () => {
  const f = fixture(); try {
    const q = await f.provider.quote({ domain: 'sample.com', operation: 'register' }); assert.equal(q.cost_usd, '11.080000'); assert.equal(q.renewal_cost_usd, '11.080000');
    for (const [premium, code] of [['yes', 'premium_not_supported'], [undefined, 'registrar_premium_status_unknown'], [false, 'registrar_premium_status_unknown']]) {
      f.setPremium(premium); await assert.rejects(f.provider.quote({ domain: 'sample.com', operation: 'register' }), { code });
    }
    f.setPremium('no'); f.setDuration(2); await assert.rejects(f.provider.quote({ domain: 'sample.com', operation: 'register' }), { code: 'unsupported_registration_period' });
  } finally { f.store.close(); }
});

test('Porkbun lost registration response replays identical request, then verifies buyer contacts and auto-renew', async () => {
  const f = fixture(); try {
    const order = await f.order(); f.setLoss('/domain/create/');
    await assert.rejects(f.provider.submit(order), { code: 'supplier_outcome_unknown' });
    assert.equal(f.row().autoRenew, 1);
    const result = await f.make().reconcile(order); assert.equal(result.status, 'delivered'); assert.equal(result.domain.autorenew, false);
    const creates = f.calls.filter(c => c.path.includes('/domain/create/'));
    assert.equal(creates.length, 2); assert.equal(creates[0].key, creates[1].key); assert.equal(creates[0].body.cost, 1108);
    assert.equal(f.receipts.length, 1); assert.equal(f.contact().email, registrant.email);
    assert.equal(f.calls.some(c => c.path.includes('/account/')), false);
    await f.make().reconcile(order); assert.equal(f.calls.filter(c => c.path.includes('/domain/create/')).length, 2);
  } finally { f.store.close(); }
});

test('Porkbun never replays an ambiguous purchase outside its guaranteed window', async () => {
  const f = fixture(); try {
    const order = await f.order(); f.setLoss('/domain/create/'); await assert.rejects(f.provider.submit(order));
    f.advance(23 * 3600000);
    await assert.rejects(f.make().reconcile(order), { code: 'porkbun_replay_window_expired' });
    assert.equal(f.calls.filter(c => c.path.includes('/domain/create/')).length, 1);
  } finally { f.store.close(); }
});

test('Porkbun rejects altered replay bodies, fractional-cent costs, previews and mismatched receipts', async () => {
  for (const variant of ['changed', 'fraction', 'preview', 'receipt']) {
    const f = fixture(); try {
      const order = await f.order();
      if (variant === 'changed') {
        f.setLoss('/domain/create/'); await assert.rejects(f.provider.submit(order)); order.quote.cost_usd = '12.00';
        await assert.rejects(f.make().reconcile(order), { code: 'porkbun_request_changed' });
      } else if (variant === 'fraction') {
        order.quote.cost_usd = '11.080001'; await assert.rejects(f.provider.submit(order), { code: 'porkbun_invalid_cost' }); assert.equal(f.receipts.length, 0);
      } else if (variant === 'preview') {
        f.setPreview(); await assert.rejects(f.provider.submit(order), { code: 'porkbun_preview_is_not_delivery' });
      } else {
        f.setReceiptCost(1109); await assert.rejects(f.provider.submit(order), { code: 'porkbun_invalid_purchase_receipt' });
      }
    } finally { f.store.close(); }
  }
});

test('Porkbun contact setup can recover its lost response without another purchase', async () => {
  const f = fixture(); try {
    const order = await f.order(); f.setLoss('/domain/updateContacts/'); await assert.rejects(f.provider.submit(order));
    assert.equal((await f.make().reconcile(order)).status, 'delivered'); assert.equal(f.receipts.length, 1);
    f.contact().email = 'someone-else@example.com';
    const record = { domain: order.domain, provider_domain_id: order.domain, prepared: order.prepared };
    await assert.rejects(f.provider.info(record), { code: 'registrar_ownership_changed' });
    assert.equal((await f.provider.reconcile(order)).status, 'pending');
  } finally { f.store.close(); }
});

test('Porkbun recovers a lost renewal using the purchase receipt, not just the increased expiry', async () => {
  const f = fixture(); try {
    const order = await f.order(); await f.provider.submit(order);
    const renewal = { ...order, id: 'renew-order', operation: 'renew', provider_domain_id: order.domain, before_expiry: f.row().expireDate };
    f.setLoss('/domain/renew/'); await assert.rejects(f.provider.submit(renewal));
    const result = await f.make().reconcile(renewal); assert.equal(result.status, 'delivered'); assert.equal(result.domain.expires_at, '2028-10-19');
    assert.equal(f.receipts.length, 2);
    const requests = f.calls.filter(c => c.path.includes('/domain/renew/')); assert.equal(requests.length, 2); assert.equal(requests[0].key, requests[1].key);
  } finally { f.store.close(); }
});

test('Porkbun DNS preserves unrelated RRsets, edits by ID and does not write unchanged records', async () => {
  const f = fixture(); try {
    const record = await f.record(); let zone = await f.provider.dnsGet(record);
    const target = [{ name: 'sample.com', type: 'A', value: '192.0.2.1', ttl: 900, prio: 0 }];
    zone = await f.provider.dnsSet(record, target, zone.revision);
    target[0].value = '192.0.2.2'; zone = await f.provider.dnsSet(record, target, zone.revision);
    assert.ok(zone.records.some(r => r.value === 'preserve')); assert.ok(zone.records.some(r => r.value === '192.0.2.2'));
    const count = f.calls.filter(c => c.key).length; await f.provider.dnsSet(record, target, zone.revision); assert.equal(f.calls.filter(c => c.key).length, count);
    await assert.rejects(f.provider.dnsSet(record, target, 'stale'), { code: 'dns_revision_changed' });
    assert.equal(f.calls.filter(c => c.path.includes('/dns/edit/')).length, 1);
  } finally { f.store.close(); }
});

test('Porkbun DNS resumes a lost create after restart with the same key and no duplicate record', async () => {
  const f = fixture(); try {
    const record = await f.record(), before = await f.provider.dnsGet(record);
    const target = [{ name: 'sample.com', type: 'A', value: '192.0.2.1', ttl: 900, prio: 0 }];
    f.setLoss('/dns/create/'); await assert.rejects(f.provider.dnsSet(record, target, before.revision));
    await assert.rejects(f.provider.dnsSet(record, [{ ...target[0], value: '192.0.2.3' }], before.revision), { code: 'porkbun_dns_reconciliation_required' });
    const after = await f.make().dnsSet(record, target, before.revision);
    assert.equal(after.records.filter(r => r.type === 'A').length, 1); assert.equal(f.store.get('porkbun-dns-pending', record.domain), null);
    const writes = f.calls.filter(c => c.path.includes('/dns/create/')); assert.equal(writes.length, 2); assert.equal(writes[0].key, writes[1].key);
  } finally { f.store.close(); }
});


test('Porkbun read retries are bounded and do not replay mutations', async () => {
  const f = fixture(); try {
    f.setReadFailures(1); assert.equal((await f.provider.quote({ domain: 'sample.com', operation: 'register' })).available, true);
    const before = f.calls.length; f.setReadFailures(3);
    await assert.rejects(f.provider.quote({ domain: 'sample.com', operation: 'register' }), { code: 'supplier_read_failed' });
    assert.equal(f.calls.length - before, 2);
  } finally { f.store.close(); }
});
