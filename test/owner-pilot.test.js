import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Store } from '../src/store.js';
import { OwnerPilot } from '../src/owner-pilot.js';

function fixture({ price = '1.54', loseResponse = false } = {}) {
  const store = new Store(':memory:', randomBytes(32));
  const calls = [], replays = new Map();
  let charges = 0, time = Date.now(), lost = false;
  const fetchImpl = async (url, options) => {
    const path = new URL(url).pathname.replace('/api/json/v3', '');
    const body = options.body && JSON.parse(options.body), key = options.headers['Idempotency-Key'];
    calls.push({ path, body, key });
    let result;
    if (path.includes('getRegistrationRequirements')) result = { apiRegisterable: true, registrationDurationYears: 1, whoisPrivacySupported: true };
    else if (path.includes('checkDomain')) result = { response: { avail: 'yes', premium: 'no', minDuration: 1, type: 'registration', price, additional: { renewal: { price: '10.81' } } } };
    else if (path.includes('/create/')) {
      if (body.dryRun) result = { dryRun: true, wouldSucceed: true, domain: 'sentinelproof.click', duration: 1, cost: 154, premium: false, sufficientFunds: true, balance: 1000 };
      else {
        assert.ok(key);
        if (!replays.has(key)) {
          charges++;
          replays.set(key, { domain: 'sentinelproof.click', cost: 154, orderId: 123, balance: 846 });
        }
        if (loseResponse && !lost) { lost = true; throw Error('lost after registration'); }
        result = replays.get(key);
      }
    } else if (path.includes('updateAutoRenew')) result = {};
    else if (path.includes('/domain/get/')) result = { domain: { domain: 'sentinelproof.click', status: 'ACTIVE', autoRenew: 0, expireDate: '2027-10-20' } };
    else throw Error(`unexpected_path:${path}`);
    return Response.json({ status: 'SUCCESS', ...result });
  };
  const args = { apiKey: 'pk1_abc123', secretKey: 'sk1_abc123', domain: 'sentinelproof.click', maxCents: 300, store, fetchImpl, now: () => time };
  return { owner: new OwnerPilot(args), args, calls, store, charges: () => charges, advance: ms => { time += ms; } };
}
test('owner pilot rejects over-budget price before even a dry-run registration', async () => {
  const f = fixture({ price: '3.01' });
  try {
    await assert.rejects(f.owner.register(), /budget_exceeded/);
    assert.equal(f.charges(), 0);
    assert.ok(!f.calls.some(c => c.path.includes('/create/')));
  } finally { f.store.close(); }
});
test('owner pilot retries lost response with the saved key and never purchases twice', async () => {
  const f = fixture({ loseResponse: true });
  try {
    await assert.rejects(f.owner.register(), /write_outcome_unknown/);
    const restarted = new OwnerPilot(f.args);
    assert.equal((await restarted.register()).cost, 154);
    const before = f.calls.length;
    assert.equal((await restarted.register()).cost, 154);
    assert.equal(f.charges(), 1);
    assert.ok(!f.calls.slice(before).some(c => c.path.includes('/create/')));
    const writes = f.calls.filter(c => c.path.includes('/create/') && !c.body.dryRun);
    assert.equal(writes.length, 2);
    assert.equal(writes[0].key, writes[1].key);
    assert.deepEqual(writes[0].body, writes[1].body);
  } finally { f.store.close(); }
});
test('owner pilot stops ambiguous purchase after replay expiry without sending another write', async () => {
  const f = fixture({ loseResponse: true });
  try {
    await assert.rejects(f.owner.register());
    f.advance(24 * 60 * 60 * 1000);
    const before = f.calls.length;
    await assert.rejects(f.owner.register(), /replay_window_expired/);
    assert.equal(f.calls.length, before);
    assert.equal(f.charges(), 1);
  } finally { f.store.close(); }
});
test('owner pilot binds state to account, domain and authorized ceiling', () => {
  const f = fixture();
  try {
    assert.throws(() => new OwnerPilot({ ...f.args, maxCents: 301 }), /maximum_budget/);
    assert.throws(() => new OwnerPilot({ ...f.args, domain: 'othersentinel.click' }), /binding_changed/);
    assert.throws(() => new OwnerPilot({ ...f.args, apiKey: 'pk1_abc456' }), /binding_changed/);
    assert.throws(() => new OwnerPilot({ ...f.args, apiKey: 'pk1_sb_abc123' }), /production_keys/);
  } finally { f.store.close(); }
});

test('DNS connection removes apex parking, preserves mail/TXT, and repeats without writes', async () => {
  const f = fixture();
  const desired = [{ name: '', type: 'A', content: '192.0.2.1' }, { name: '_vercel', type: 'TXT', content: 'verification' }];
  let rows = [
    { id: '1', name: 'sentinelproof.click', type: 'ALIAS', content: 'parking.example' },
    { id: '2', name: 'sentinelproof.click', type: 'MX', content: 'mail.example', prio: '10' },
    { id: '3', name: '_vercel.sentinelproof.click', type: 'TXT', content: 'keep-me' },
  ], writes = 0, next = 4;
  f.store.put('owner-writes', 'registration', { result: { domain: 'sentinelproof.click' } });
  f.owner.api = async (method, path, body) => {
    if (path.includes('getNs')) return { ns: ['curitiba.ns.porkbun.com'] };
    if (path.includes('retrieve')) return { records: structuredClone(rows) };
    writes++;
    if (path.includes('/delete/')) rows = rows.filter(r => r.id !== path.split('/').at(-1));
    else if (path.includes('/create/')) rows.push({ ...body, id: String(next++), name: body.name ? `${body.name}.sentinelproof.click` : 'sentinelproof.click' });
    else throw Error('unexpected_dns_path');
    return { status: 'SUCCESS' };
  };
  try {
    await f.owner.configureDNS(desired);
    assert.equal(writes, 3);
    await f.owner.configureDNS(desired);
    assert.equal(writes, 3);
    assert.ok(rows.some(r => r.type === 'MX' && r.content === 'mail.example'));
    assert.ok(rows.some(r => r.type === 'TXT' && r.content === 'keep-me'));
    await assert.rejects(f.owner.configureDNS([{ ...desired[0], content: '192.0.2.2' }]), /target_changed/);
  } finally { f.store.close(); }
});
