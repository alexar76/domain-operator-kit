import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, DomainService, demoProvider, demoPayments, signer, SupplierError } from '../src/index.js';
import { dollars, units, splitDomain } from '../src/core.js';

export const CONTACT = { first_name: 'Alex', last_name: 'Buyer', email: 'private@example.org', phone_country: '+1', phone_number: '5551234567', street: 'Private Street', number: '1', city: 'City', postal_code: '12345', country: 'US' };
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'domain-kit-')), path = join(dir, 'orders.sqlite'), key = Buffer.alloc(32, 11);
  let store = new Store(path, key), now = Date.now(); const owner = signer(), providerKey = signer();
  let provider = demoProvider(store), payments = demoPayments(), service;
  const calls = { submit: 0, settle: 0, refund: 0, prepare: 0 };
  const originalSubmit = provider.submit.bind(provider), originalSettle = payments.settle, originalPrepare = provider.prepare;
  provider.submit = async o => { calls.submit++; return originalSubmit(o); };
  provider.prepare = async o => { calls.prepare++; return originalPrepare(o); };
  payments.settle = async (...a) => { calls.settle++; return originalSettle(...a); };
  payments.refundPayload = async () => { calls.refund++; return { payload: {}, terms: {} }; };
  const make = () => new DomainService({ store, provider, payments, signer: providerKey, origin: 'https://seller.example', now: () => now,
    markupUsd: '2.00', termsUrl: 'https://seller.example/terms' });
  service = make();
  return { dir, owner: owner.publicKey, other: signer().publicKey, provider, payments, calls,
    get service() { return service; }, get store() { return store; }, advance(ms) { now += ms; },
    restart() { store.close(); store = new Store(path, key); service = make(); },
    async input(domain = 'testdomain.com', operation = 'register') {
      const q = await service.quote({ domain, operation }, owner.publicKey);
      return { quote_id: q.quote_id, client_order_id: `client-${Math.random().toString(36).slice(2)}-${Date.now()}`, accept_terms: true, terms_version: '1', ...(operation === 'register' ? { registrant: CONTACT } : {}) };
    },
    close() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('quotes use exact decimal fixed markup and disclose renewal estimate; only registrable supported names', async () => {
  const f = fixture(); try {
    const q = await f.service.quote({ domain: 'TestDomain.COM' });
    assert.equal(q.price_usd, '12.000000'); assert.equal(q.markup_usd, '2.000000'); assert.equal(q.renewal_estimate_usd, '14.000000'); assert.equal(q.domain_reserved, false);
    assert.equal(dollars(units('0.100001') + units('0.200002')), '0.300003');
    for (const name of ['a.com.evil', 'https://a.com', 'a..com', 'x.a.com', 'a.com.', 'пример.com', 'a.com/path']) await assert.rejects(f.service.quote({ domain: name }));
    assert.deepEqual(splitDomain('sample.co.uk', ['uk', 'co.uk']), { domain: 'sample.co.uk', name: 'sample', extension: 'co.uk' });
  } finally { f.close(); }
});

test('parallel retries register and charge once; changed payload is rejected; ownership stays separate', async () => {
  const f = fixture(); try {
    const input = await f.input();
    const results = await Promise.all(Array.from({ length: 8 }, () => f.service.order(input, f.owner, 'register')));
    assert.equal(f.calls.submit, 1); assert.equal(f.calls.settle, 1); assert.ok(results.every(r => r.status === 'delivered'));
    assert.equal(results[0].receipt.owner_key_sha256.length, 64);
    await assert.rejects(f.service.order({ ...input, registrant: { ...CONTACT, email: 'other@example.org' } }, f.owner, 'register'), { code: 'idempotency_conflict' });
    await assert.rejects(f.service.info({ domain: 'testdomain.com' }, f.other), { code: 'domain_not_found' });
    await assert.rejects(f.service.status({ order_id: results[0].order_id }, f.other), { code: 'order_not_found' });
    const publicResult = JSON.stringify(results[0]); assert.ok(!publicResult.includes(CONTACT.email)); assert.ok(!publicResult.includes('customer_handle'));
    assert.equal(f.store.get('orders', results[0].order_id).registrant, null);
  } finally { f.close(); }
});

test('expired quotes, stale supplier prices and unavailable domains never charge', async () => {
  const f = fixture(); try {
    const input = await f.input(); f.advance(300001);
    await assert.rejects(f.service.order(input, f.owner, 'register'), { code: 'quote_expired_or_unknown' });
    const fresh = await f.input(); const quote = f.provider.quote;
    f.provider.quote = async o => ({ ...await quote(o), cost_usd: '100.00' });
    await assert.rejects(f.service.order(fresh, f.owner, 'register'), { code: 'requote_required' });
    assert.equal(f.calls.settle, 0); assert.equal(f.calls.submit, 0);
  } finally { f.close(); }
});

test('uncertain settlement survives restart and recovers from evidence without charging twice', async () => {
  const f = fixture(); try {
    const input = await f.input(); f.payments.settle = async () => { f.calls.settle++; throw Error('connection lost after charge'); };
    const first = await f.service.order(input, f.owner, 'register');
    assert.equal(first.status, 'settlement_pending'); assert.equal(f.calls.submit, 0);
    f.restart();
    assert.equal((await f.service.order(input, f.owner, 'register')).status, 'settlement_pending');
    f.payments.reconcile = async () => ({ status: 'paid', transaction: 'confirmed-original-payment' });
    // New provider view uses the reopened store, preserving its transaction ledger.
    const recovered = demoProvider(f.store); f.provider.quote = recovered.quote;
    f.provider.submit = async o => { f.calls.submit++; return recovered.submit(o); };
    await f.service.reconcileAll(); await f.service.reconcileAll();
    assert.equal((await f.service.status({ order_id: first.order_id }, f.owner)).status, 'delivered');
    assert.equal(f.calls.settle, 1); assert.equal(f.calls.submit, 1);
  } finally { f.close(); }
});

test('ambiguous registrar submit is never repeated or refunded without definitive evidence', async () => {
  const f = fixture(); try {
    const input = await f.input(); const realSubmit = f.provider.submit;
    f.provider.submit = async o => { await realSubmit(o); throw Error('lost registration response'); };
    const first = await f.service.order(input, f.owner, 'register');
    assert.equal(first.status, 'registration_pending');
    await f.service.order(input, f.owner, 'register'); assert.equal(f.calls.submit, 1); assert.equal(f.calls.refund, 0);
    await f.service.reconcileAll();
    assert.equal((await f.service.status({ order_id: first.order_id }, f.owner)).status, 'delivered'); assert.equal(f.calls.submit, 1);
  } finally { f.close(); }
});

test('definitive registration refusal automatically refunds once and retains proof', async () => {
  const f = fixture(); try {
    f.provider.submit = async () => { f.calls.submit++; throw new SupplierError('taken', { definite: true }); };
    const input = await f.input(); const result = await f.service.order(input, f.owner, 'register');
    assert.equal(result.status, 'refunded'); assert.equal(f.calls.refund, 1); assert.ok(result.refund_transaction);
    await f.service.order(input, f.owner, 'register'); await f.service.reconcileAll();
    assert.equal(f.calls.refund, 1); assert.equal(f.calls.settle, 2); assert.equal(f.store.get('domain-locks', result.domain), null);
  } finally { f.close(); }
});

test('uncertain refund is not re-signed and resolves by the original authorization', async () => {
  const f = fixture(); try {
    f.provider.submit = async () => { throw new SupplierError('refused', { definite: true }); };
    f.payments.settle = async () => { if (++f.calls.settle > 1) throw Error('lost refund reply'); return { transaction: 'charge' }; };
    const result = await f.service.order(await f.input(), f.owner, 'register');
    assert.equal(result.status, 'refund_pending');
    await f.service.reconcileAll(); assert.equal(f.calls.refund, 1); assert.equal(f.calls.settle, 2);
    f.payments.reconcile = async () => ({ status: 'paid', transaction: 'original-refund' });
    await f.service.reconcileAll(); assert.equal((await f.service.status({ order_id: result.order_id }, f.owner)).refund_transaction, 'original-refund');
  } finally { f.close(); }
});

test('payment nonce cannot buy a second domain, even for another owner', async () => {
  const f = fixture(); try {
    f.payments.inspect = () => ({ payer: 'same-payer', reference: 'same-nonce', payload: {}, fingerprint: 'same' });
    await f.service.order(await f.input(), f.owner, 'register');
    await assert.rejects(f.service.order(await f.input('second.com'), f.other, 'register'), { code: 'payment_already_bound' });
    assert.equal(f.calls.settle, 1);
  } finally { f.close(); }
});

test('renewals require ownership and stale expiry quotes cannot renew twice', async () => {
  const f = fixture(); try {
    const first = await f.service.order(await f.input(), f.owner, 'register');
    const renewal = await f.input(first.domain, 'renew'); const stale = await f.input(first.domain, 'renew');
    const next = await f.service.order(renewal, f.owner, 'renew');
    assert.ok(Date.parse(next.domain_info.expires_at) > Date.parse(first.domain_info.expires_at));
    await assert.rejects(f.service.order(stale, f.owner, 'renew'), { code: 'renewal_quote_stale' });
    await assert.rejects(f.service.quote({ domain: first.domain, operation: 'renew' }, f.other), { code: 'domain_not_found' });
  } finally { f.close(); }
});

test('DNS updates preserve unrelated records, enforce revisions and isolate owners', async () => {
  const f = fixture(); try {
    const order = await f.service.order(await f.input(), f.owner, 'register'), domain = order.domain;
    const initial = await f.service.dnsGet({ domain }, f.owner);
    const txt = await f.service.dnsSet({ domain, revision: initial.revision, records: [{ name: domain, type: 'TXT', value: 'keep-me', ttl: 300 }] }, f.owner);
    const result = await f.service.dnsSet({ domain, revision: txt.revision, records: [{ name: domain, type: 'A', value: '192.0.2.1', ttl: 300 }] }, f.owner);
    assert.equal(result.records.length, 2); assert.ok(result.records.some(r => r.value === 'keep-me'));
    await assert.rejects(f.service.dnsSet({ domain, revision: txt.revision, records: [{ name: domain, type: 'A', value: '192.0.2.2', ttl: 300 }] }, f.owner), { code: 'dns_revision_changed' });
    await assert.rejects(f.service.dnsSet({ domain, revision: result.revision, records: [{ name: 'evil.com', type: 'A', value: '192.0.2.2', ttl: 300 }] }, f.owner), { code: 'dns_name_outside_domain' });
    await assert.rejects(f.service.dnsGet({ domain }, f.other), { code: 'domain_not_found' });
  } finally { f.close(); }
});

test('store encrypts registrants at rest and fails closed on wrong key', async () => {
  const f = fixture(); try {
    f.store.put('secret', 'test', CONTACT);
    assert.ok(!readFileSync(join(f.dir, 'orders.sqlite-wal')).includes(Buffer.from(CONTACT.email)));
    assert.throws(() => new Store(join(f.dir, 'orders.sqlite'), Buffer.alloc(32, 12)));
  } finally { f.close(); }
});

test('live mode cannot accidentally use demo payments or a sandbox registrar', () => {
  const f = fixture(); try { assert.throws(() => new DomainService({ ...f.service, mode: 'live' }), /live mode requires/); } finally { f.close(); }
});

test('refund signing failure releases unused reservation and can recover without duplicate settlement', async () => {
  const f = fixture(); try {
    f.provider.submit = async () => { throw new SupplierError('refused', { definite: true }); };
    const sign = f.payments.refundPayload; f.payments.refundPayload = async () => { throw Error('signer unavailable'); };
    const result = await f.service.order(await f.input(), f.owner, 'register'); assert.equal(result.status, 'refund_due');
    assert.equal(f.store.all('refund-budget')[0].reserved, '0'); assert.equal(f.calls.settle, 1);
    f.payments.refundPayload = sign; await f.service.reconcileAll();
    assert.equal((await f.service.status({ order_id: result.order_id }, f.owner)).status, 'refunded'); assert.equal(f.calls.settle, 2);
  } finally { f.close(); }
});

test('an already-created unpaid renewal cannot bypass expiry guard after another renewal succeeds', async () => {
  const f = fixture(); try {
    await f.service.order(await f.input(), f.owner, 'register');
    const stale = await f.input('testdomain.com', 'renew');
    f.service.orderInput(stale, f.owner, 'renew'); // first request returned a 402 before payment
    await f.service.order(await f.input('testdomain.com', 'renew'), f.owner, 'renew');
    await assert.rejects(f.service.order(stale, f.owner, 'renew'), { code: 'renewal_quote_stale' });
    assert.equal(f.calls.settle, 2);
  } finally { f.close(); }
});

test('a pending registrar order is refunded only after explicit operator evidence, never on a failed lookup', async () => {
  const f = fixture(); try {
    f.provider.submit = async () => { throw Error('unknown'); };
    f.provider.reconcile = async () => { throw Error('registrar read failed'); };
    const result = await f.service.order(await f.input(), f.owner, 'register');
    await f.service.reconcileAll(); assert.equal(f.calls.refund, 0);
    f.store.put('operator-evidence', result.order_id, { conclusion: 'registrar_confirmed_no_registration_or_renewal', reference: 'checked-case-12345' });
    await f.service.reconcileAll(); assert.equal(f.calls.refund, 1);
    assert.equal((await f.service.status({ order_id: result.order_id }, f.owner)).status, 'refunded');
  } finally { f.close(); }
});
