import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VercelConnector } from '../src/vercel.js';

function fixture(records = []) {
  const calls = [], mutations = []; let attached = null, dns = structuredClone(records);
  const client = { async call(key, input) {
    calls.push({ key, input });
    if (key === 'info') return { domain: input.domain, status: 'active' };
    if (key === 'dnsGet') return { records: dns, revision: 'revision' };
    if (key === 'dnsSet') { mutations.push(input); const keys = new Set(input.records.map(r => `${r.name}:${r.type}`)); dns = [...dns.filter(r => !keys.has(`${r.name}:${r.type}`)), ...input.records]; }
  } };
  const config = { recommendedIPv4: [{ rank: 2, value: ['192.0.2.2'] }, { rank: 1, value: ['192.0.2.1'] }], misconfigured: true };
  const fetchImpl = async (url, options) => {
    assert.equal(url.origin, 'https://api.vercel.com'); assert.equal(url.searchParams.get('teamId'), 'team-test');
    assert.equal(options.headers.authorization, 'Bearer local-secret');
    if (url.pathname.endsWith('/config')) return Response.json(config);
    if (options.method === 'GET') return attached ? Response.json(attached) : Response.json({}, { status: 404 });
    if (url.pathname.endsWith('/verify')) return Response.json({}, { status: 400 });
    attached = { name: 'sample.com', verified: false, verification: [{ type: 'TXT', domain: '_vercel.sample.com', value: 'challenge' }] };
    return Response.json(attached);
  };
  return { connector: new VercelConnector({ client, token: 'local-secret', project: 'prj-pinned', team: 'team-test', fetchImpl }), calls, mutations, config };
}

test('Vercel uses preferred live DNS recommendation, preserves TXT/MX and retries without DNS writes', async () => {
  const f = fixture([{ name: 'sample.com', type: 'MX', value: 'mail.example.net', prio: 10, ttl: 300 }, { name: '_vercel.sample.com', type: 'TXT', value: 'keep', ttl: 300 }]);
  const result = await f.connector.connect({ domain: 'sample.com' });
  assert.equal(result.status, 'waiting_for_verification_or_dns');
  assert.ok(result.records.some(r => r.type === 'A' && r.value === '192.0.2.1'));
  assert.ok(result.records.some(r => r.type === 'TXT' && r.value === 'keep'));
  assert.ok(!JSON.stringify(f.calls).includes('local-secret')); assert.equal(f.mutations.length, 1);
  await f.connector.connect({ domain: 'sample.com' }); assert.equal(f.mutations.length, 1);
});

test('Vercel refuses overwriting existing routing without explicit instruction and never leaves conflicting IPv6', async () => {
  const f = fixture([{ name: 'sample.com', type: 'A', value: '192.0.2.9', ttl: 300 }]);
  await assert.rejects(f.connector.connect({ domain: 'sample.com' }), { code: 'existing_dns_requires_explicit_replacement' }); assert.equal(f.mutations.length, 0);
  await f.connector.connect({ domain: 'sample.com', replace_existing: true }); assert.equal(f.mutations.length, 1);
  const ipv6 = fixture([{ name: 'sample.com', type: 'AAAA', value: '2001:db8::1', ttl: 300 }]);
  await assert.rejects(ipv6.connector.connect({ domain: 'sample.com', replace_existing: true }), { code: 'remove_conflicting_ipv6_or_cname_first' });
});
