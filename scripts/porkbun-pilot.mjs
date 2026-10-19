// Explicit opt-in integration test. Creates ONE domain in Porkbun Sandbox,
// writes test DNS, renews once, and retains state to resume the same orders.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { Store, DomainService, demoPayments, signer, createHttpServer } from '../src/index.js';
import { porkbun } from '../src/porkbun.js';
import { DomainClient } from '../src/client.js';

if (process.env.DOMAIN_MODE !== 'sandbox' || process.env.DOMAIN_SANDBOX_PILOT !== '1') {
  throw Error('Requires DOMAIN_MODE=sandbox and DOMAIN_SANDBOX_PILOT=1; this creates sandbox resources.');
}
const dir = resolve(process.env.DOMAIN_PILOT_DIR || 'data/porkbun-pilot');
mkdirSync(dir, { recursive: true, mode: 0o700 });
const lock = join(dir, 'pilot.lock');
writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
const checkpoint = join(dir, 'pilot.json');
const state = existsSync(checkpoint) ? JSON.parse(readFileSync(checkpoint, 'utf8')) : {
  domain: `domain-kit-pb-${randomBytes(6).toString('hex')}.com`, requests: {},
};
function save() { writeFileSync(`${checkpoint}.tmp`, JSON.stringify(state, null, 2), { mode: 0o600 }); renameSync(`${checkpoint}.tmp`, checkpoint); }
function key(name, make) { const p = join(dir, name); if (!existsSync(p)) writeFileSync(p, make(), { mode: 0o600, flag: 'wx' }); return readFileSync(p, 'utf8').trim(); }
const secret = name => readFileSync(process.env[name], 'utf8').trim();
const log = (step, details = {}) => console.log(JSON.stringify({ step, ...details }));
let store, server, service, client;
async function stop() { if (server) { await new Promise(resolve => server.close(resolve)); server = null; } if (store) { store.close(); store = null; } }
async function start() {
  store = new Store(join(dir, 'orders.sqlite'), Buffer.from(key('encryption.key', () => randomBytes(32).toString('hex')), 'hex'));
  const seller = signer(key('seller.pem', () => signer().pem)), owner = signer(key('owner.pem', () => signer().pem));
  const provider = porkbun({ apiKey: secret('PORKBUN_API_KEY_FILE'), secretKey: secret('PORKBUN_SECRET_KEY_FILE'), sandbox: true, store,
    fetchImpl: async (url, options) => {
      assert.equal(new URL(url).origin, 'https://api.porkbun.com');
      const path = new URL(url).pathname, requestKey = `${options.method} ${path}`;
      state.requests[requestKey] = (state.requests[requestKey] || 0) + 1; save();
      const response = await fetch(url, options);
      const data = await response.clone().json().catch(() => ({}));
      if (!response.ok || data.status !== 'SUCCESS') log('registrar_error', { method: options.method, path, http: response.status, code: data.code });
      assert.equal(data.sandbox, true, 'Every response must confirm sandbox');
      if (/\/domain\/(create|renew)\//.test(path) && data.status === 'SUCCESS') {
        const operation = path.includes('/create/') ? 'register' : 'renew';
        state.receipts ||= {}; state.receipts[operation] ||= [];
        if (!state.receipts[operation].includes(data.orderId)) state.receipts[operation].push(data.orderId);
        const field = `${operation}LostResponse`;
        if (!state[field]) {
          state[field] = true; save(); log('injected_lost_response', { operation });
          throw Error('Simulated response loss after successful sandbox purchase');
        }
      }
      if (path.includes('/dns/create/') && data.status === 'SUCCESS' && !state.dnsLostResponse) {
        state.dnsLostResponse = true; save(); log('injected_lost_dns_response');
        throw Error('Simulated DNS response loss after commit');
      }
      save(); return response;
    } });
  service = new DomainService({ store, provider, payments: demoPayments(), signer: seller, origin: 'http://127.0.0.1',
    mode: 'sandbox', termsUrl: 'https://example.invalid/sandbox-test-terms' });
  server = createHttpServer(service);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  service.origin = `http://127.0.0.1:${server.address().port}`;
  client = new DomainClient({ url: service.origin, sellerKey: seller.publicKey, productId: service.productId, ownerKey: owner,
    allowLocal: true, allowDemo: true, maxPurchaseUsd: '30' });
}
async function delivered(order) {
  for (let i = 0; i < 6 && order.status === 'registration_pending'; i++) {
    await service.reconcileAll();
    order = await client.call('status', { order_id: order.order_id });
    log('reconciliation', { status: order.status });
    if (order.status === 'registration_pending' && i < 5) await new Promise(resolve => setTimeout(resolve, 5000));
  }
  assert.equal(order.status, 'delivered', `Order remains ${order.status}; rerun with the SAME pilot directory, never a new order.`);
  assert.ok(order.receipt_signature); return order;
}
async function orderInput(operation) {
  const field = `${operation}Input`;
  if (!state[field]) {
    const quote = await client.call('quote', { domain: state.domain, operation });
    assert.equal(quote.available, true); assert.ok(Number(quote.price_usd) <= 30);
    state[field] = { quote_id: quote.quote_id, client_order_id: `sandbox-${operation}-${randomBytes(12).toString('hex')}`, accept_terms: true, terms_version: quote.terms_version };
    if (operation === 'register') state[field].registrant = {
      first_name: 'Sandbox', last_name: 'Tester', email: 'sandbox@example.com', phone_country: '+1', phone_area: '202', phone_number: '5550100',
      street: 'Example Street', number: '1', city: 'Washington', state: 'DC', postal_code: '20001', country: 'US',
    };
    state[`${operation}Price`] = quote.price_usd; save();
  }
  return state[field];
}
async function mcpCheck(orderId) {
  const proc = spawn(process.execPath, ['bin/domain-rails.mjs', 'mcp'], { cwd: new URL('..', import.meta.url), env: { ...process.env,
    DOMAIN_BUYER_DATA_DIR: join(dir, 'mcp-buyer'), DOMAIN_OWNER_KEY_FILE: join(dir, 'owner.pem'),
    DOMAIN_SELLER_URL: service.origin, DOMAIN_SELLER_KEY: service.signer.publicKey, DOMAIN_SELLER_PRODUCT: service.productId,
    DOMAIN_ALLOW_DEMO: '1', DOMAIN_BUY_MAX_USD: '0', DOMAIN_BUYER_KEY_FILE: '', VERCEL_TOKEN_FILE: '', VERCEL_PROJECT_ID: '',
  }, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = new Promise(resolve => proc.once('exit', resolve)); proc.stderr.resume();
  const pending = new Map(); let counter = 0;
  const lines = createInterface({ input: proc.stdout });
  lines.on('line', line => { const result = JSON.parse(line); pending.get(result.id)?.(result); });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++counter, timer = setTimeout(() => { pending.delete(id); reject(Error('MCP timeout')); }, 30000);
    pending.set(id, result => { clearTimeout(timer); pending.delete(id); resolve(result); });
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  try {
    const init = await rpc('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'sandbox-pilot', version: '1' }, capabilities: {} });
    assert.equal(init.result.serverInfo.name, 'domain-rails');
    for (const [name, args] of [['status', { order_id: orderId }], ['info', { domain: state.domain }], ['dnsGet', { domain: state.domain }]]) {
      const r = await rpc('tools/call', { name, arguments: args }); assert.ok(!r.result.isError, `MCP ${name} failed`);
      const data = JSON.parse(r.result.content[0].text);
      if (name === 'status') assert.equal(data.status, 'delivered');
      if (name === 'info') assert.equal(data.domain, state.domain);
      if (name === 'dnsGet') assert.ok(data.records.some(r => r.value === '192.0.2.42'));
    }
  } finally { proc.stdin.end(); await exited; lines.close(); }
}
try {
  save(); log('start', { domain: state.domain, mode: 'sandbox', payment: 'simulated' }); await start();
  const input = await orderInput('register');
  let order = await client.call('register', input); state.registrationOrderId = order.order_id; save();
  log('registration_response', { status: order.status });
  // Reopen SQLite and rebuild the service before recovering the lost response.
  await stop(); await start(); order = await delivered(await client.call('register', input));
  assert.equal(state.receipts.register.length, 1, 'Replay must return the same purchase receipt');
  state.registrationDelivered = true; save(); log('registration_recovered_after_restart');
  let info = await client.call('info', { domain: state.domain });
  assert.equal(info.autorenew, false);
  if (!state.initialExpiry) { state.initialExpiry = info.expires_at; save(); }
  const outsider = new DomainClient({ url: service.origin, sellerKey: service.signer.publicKey, productId: service.productId,
    ownerKey: signer(), allowLocal: true, allowDemo: true });
  await assert.rejects(outsider.call('info', { domain: state.domain }), { code: 'domain_not_found' }); log('owner_isolation_passed');
  const steps = [
    [{ name: `_recovery.${state.domain}`, type: 'TXT', value: 'domain-kit-recovery', ttl: 900, prio: 0 }],
    [{ name: `_pilot.${state.domain}`, type: 'TXT', value: 'domain-kit-preserve', ttl: 900, prio: 0 }],
    [{ name: state.domain, type: 'A', value: '192.0.2.41', ttl: 900, prio: 0 }],
    [{ name: state.domain, type: 'A', value: '192.0.2.42', ttl: 900, prio: 0 }],
  ];
  state.dnsStep ||= 0;
  while (state.dnsStep < steps.length) {
    if (!state.dnsInput) {
      const current = await client.call('dnsGet', { domain: state.domain });
      state.dnsInput = { domain: state.domain, revision: current.revision, records: steps[state.dnsStep] }; save();
    }
    try { await client.call('dnsSet', state.dnsInput); }
    catch (error) {
      log('dns_retry_same_intent', { error: error.code });
      await stop(); await start();
      await client.call('dnsSet', state.dnsInput);
    }
    state.dnsInput = null; state.dnsStep++; save();
  }
  let dns = await client.call('dnsGet', { domain: state.domain });
  const dnsCount = () => Object.entries(state.requests).filter(([p]) => /^POST .*\/dns\//.test(p)).reduce((n, [, count]) => n + count, 0);
  const dnsWrites = dnsCount();
  dns = await client.call('dnsSet', { domain: state.domain, revision: dns.revision, records: steps.at(-1) });
  assert.equal(dnsCount(), dnsWrites, 'Unchanged DNS must not write');
  assert.equal(dns.records.filter(r => r.type === 'TXT' && r.value === 'domain-kit-preserve').length, 1);
  assert.equal(dns.records.filter(r => r.type === 'A' && r.value === '192.0.2.42').length, 1);
  log('dns_write_and_preservation_passed');
  const renewalInput = await orderInput('renew');
  let renewal = await client.call('renew', renewalInput);
  await stop(); await start();
  renewal = await delivered(await client.call('renew', renewalInput));
  state.renewalOrderId = renewal.order_id; save();
  await stop(); await start();
  renewal = await client.call('renew', renewalInput); assert.equal(renewal.status, 'delivered');
  info = await client.call('info', { domain: state.domain }); assert.ok(Date.parse(info.expires_at) > Date.parse(state.initialExpiry));
  assert.equal(state.receipts.renew.length, 1, 'Renewal replay must return the same purchase receipt');
  const expectedExpiry = new Date(state.initialExpiry); expectedExpiry.setUTCFullYear(expectedExpiry.getUTCFullYear() + 1);
  assert.equal(Date.parse(info.expires_at), expectedExpiry.getTime(), 'Renewal must add exactly one year');
  assert.equal(info.autorenew, false);
  log('renewal_and_repeat_after_restart_passed', { autorenew: false, owner_matches: true });
  await mcpCheck(renewal.order_id); log('mcp_status_info_dns_passed');
  state.complete = true; state.completedAt = new Date().toISOString(); save();
  log('complete', { domain: state.domain, registration_price: state.registerPrice, renewal_price: state.renewPrice,
    registration_receipts: state.receipts.register.length, renewal_receipts: state.receipts.renew.length, lost_registration_recovered: !!state.registerLostResponse, lost_renewal_recovered: !!state.renewLostResponse, lost_dns_recovered: !!state.dnsLostResponse });
} catch (error) {
  log('failed', { error: error.code || error.message }); process.exitCode = 1;
} finally { await stop(); unlinkSync(lock); }
