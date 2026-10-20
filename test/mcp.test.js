import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, DomainService, demoProvider, demoPayments, signer, createHttpServer } from '../src/index.js';

test('MCP subprocess lists safe tools and completes quote/register/status/DNS with private local contact', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'domain-mcp-')), owner = signer(), seller = signer();
  const store = new Store(':memory:', Buffer.alloc(32, 7));
  const service = new DomainService({ store, provider: demoProvider(store), payments: demoPayments(), signer: seller, origin: 'http://127.0.0.1', termsUrl: 'https://example.invalid/terms' });
  const server = createHttpServer(service); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  service.origin = `http://127.0.0.1:${server.address().port}`;
  writeFileSync(join(dir, 'owner.pem'), owner.pem, { mode: 0o600 });
  writeFileSync(join(dir, 'contact.json'), JSON.stringify({ first_name: 'Test', last_name: 'Buyer', email: 'secret@example.net', phone_country: '+1', phone_number: '5551234567', street: 'Street', number: '1', city: 'City', postal_code: '12345', country: 'US' }));
  const proc = spawn(process.execPath, ['bin/domain-rails.mjs', 'mcp'], { cwd: new URL('..', import.meta.url), env: { ...process.env,
    DOMAIN_BUYER_DATA_DIR: join(dir, 'buyer'), DOMAIN_OWNER_KEY_FILE: join(dir, 'owner.pem'), DOMAIN_REGISTRANT_FILE: join(dir, 'contact.json'),
    DOMAIN_SELLER_URL: service.origin, DOMAIN_SELLER_KEY: seller.publicKey, DOMAIN_SELLER_PRODUCT: 'domains-operator', DOMAIN_ALLOW_DEMO: '1', DOMAIN_BUY_MAX_USD: '20',
    DOMAIN_BUYER_KEY_FILE: '', VERCEL_TOKEN_FILE: '', VERCEL_PROJECT_ID: '' }, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = new Promise(resolve => proc.once('exit', resolve));
  proc.stderr.resume(); const pending = new Map(); let counter = 0;
  const lines = createInterface({ input: proc.stdout });
  lines.on('line', line => { const r = JSON.parse(line); pending.get(r.id)?.(r); });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++counter, timeout = setTimeout(() => reject(Error('MCP timeout')), 10000);
    pending.set(id, result => { clearTimeout(timeout); pending.delete(id); resolve(result); });
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const tool = async (name, args) => { const r = await rpc('tools/call', { name, arguments: args }); assert.ok(!r.result.isError, r.result.content[0].text); return JSON.parse(r.result.content[0].text); };
  try {
    const init = await rpc('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'fixture', version: '1' }, capabilities: {} }); assert.equal(init.result.serverInfo.name, 'domain-rails');
    const list = (await rpc('tools/list', {})).result.tools;
    assert.ok(!list.some(t => t.name === 'transferCode')); assert.ok(!list.find(t => t.name === 'register').inputSchema.properties.registrant);
    const q = await tool('quote', { domain: 'mcp-demo.com' });
    const order = await tool('register', { quote_id: q.quote_id, client_order_id: 'mcp-demo-order-123456', accept_terms: true, terms_version: '1' });
    assert.equal(order.status, 'delivered'); assert.ok(!JSON.stringify(order).includes('secret@example.net'));
    assert.equal((await tool('status', { order_id: order.order_id })).status, 'delivered');
    const dns = await tool('dnsGet', { domain: order.domain });
    const result = await tool('dnsSet', { domain: order.domain, revision: dns.revision, records: [{ name: order.domain, type: 'A', value: '192.0.2.1', ttl: 300 }] });
    assert.equal(result.records[0].value, '192.0.2.1');
  } finally {
    proc.stdin.end(); await exited;
    lines.close(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test('MCP lists tools with no seller and no owner key', async () => {
  const proc = spawn(process.execPath, ['bin/domain-rails.mjs', 'mcp'], {
    cwd: new URL('..', import.meta.url),
    env: { PATH: process.env.PATH },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const lines = createInterface({ input: proc.stdout });
  const pending = new Map();
  lines.on('line', line => { const message = JSON.parse(line); pending.get(message.id)?.(message); });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = method === 'initialize' ? 1 : 2;
    const timeout = setTimeout(() => reject(Error('MCP timeout')), 10000);
    pending.set(id, result => { clearTimeout(timeout); resolve(result); });
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  try {
    const init = await rpc('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'probe', version: '0' }, capabilities: {} });
    assert.equal(init.result.serverInfo.name, 'domain-rails');
    const names = (await rpc('tools/list', {})).result.tools.map(tool => tool.name);
    assert.ok(names.includes('quote'));
    assert.ok(!names.includes('transferCode'));
    assert.equal(proc.exitCode, null);
  } finally {
    proc.stdin.end();
    lines.close();
    proc.kill();
  }
});
