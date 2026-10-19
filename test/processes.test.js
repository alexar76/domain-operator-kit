import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { httpProvider } from '../src/providers.js';

function child(script, env) {
  const p = spawn(process.execPath, [script], { cwd: new URL('..', import.meta.url), env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  p.stdout.on('data', b => { output += b; }); p.stderr.on('data', b => { output += b; });
  const exited = new Promise(resolve => p.once('exit', (code, signal) => resolve({ code, signal })));
  return { p, exited, output: () => output, async stop() { if (p.exitCode === null && !p.killed) p.kill('SIGTERM'); await exited; } };
}
async function ready(proc, pattern) {
  for (let n = 0; n < 100; n++) { const match = pattern.exec(proc.output()); if (match) return match;
    if (proc.p.exitCode !== null) throw Error(proc.output()); await new Promise(r => setTimeout(r, 20)); }
  throw Error('process did not become ready');
}

test('server boot persists identity, rejects second process and removes lock on graceful shutdown', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'domain-server-'));
  const env = { DOMAIN_MODE: 'demo', DOMAIN_PROVIDER: 'demo', DOMAIN_DATA_DIR: dir, PORT: '0' };
  let first, second, restart;
  try {
    first = child('src/server.js', env); await ready(first, /domain seller listening/);
    assert.ok(existsSync(join(dir, 'orders.sqlite'))); assert.ok(existsSync(join(dir, 'server.lock')));
    second = child('src/server.js', env); assert.equal((await second.exited).code, 1); assert.match(second.output(), /already running/);
    await first.stop(); assert.equal(existsSync(join(dir, 'server.lock')), false);
    restart = child('src/server.js', env); await ready(restart, /domain seller listening/); await restart.stop();
  } finally { await first?.stop(); await second?.stop(); await restart?.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test('independent HTTP supplier example completes authenticated quote, issue, reconciliation and DNS', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'domain-supplier-')), secret = 'example-test-secret-'.repeat(3), path = join(dir, 'hmac.key');
  writeFileSync(path, secret, { mode: 0o600 });
  const proc = child('examples/supplier.mjs', { DOMAIN_SUPPLIER_SECRET_FILE: path, DOMAIN_SUPPLIER_DATA_DIR: dir, DOMAIN_SUPPLIER_PORT: '0' });
  try {
    const match = await ready(proc, /port=(\d+)/);
    const provider = httpProvider({ url: `http://127.0.0.1:${match[1]}`, secret, sandbox: true, allowLocal: true, tlds: ['com'] });
    const q = await provider.quote({ domain: 'supplier-demo.com', operation: 'register', period_years: 1 }); assert.equal(q.available, true);
    const prepared = await provider.prepare({ order_id: 'supplier-order-1', registrant: {} });
    const order = { id: 'supplier-order-1', domain: 'supplier-demo.com', operation: 'register', prepared, quote: { cost_usd: q.cost_usd } };
    const result = await provider.submit(order); assert.equal(result.status, 'delivered'); assert.equal((await provider.reconcile(order)).status, 'delivered');
    const record = { ...result.domain, prepared }; const dns = await provider.dnsGet(record);
    const changed = await provider.dnsSet(record, [{ name: record.domain, type: 'A', value: '192.0.2.10', ttl: 900 }], dns.revision); assert.equal(changed.records[0].value, '192.0.2.10');
    const wrong = httpProvider({ url: `http://127.0.0.1:${match[1]}`, secret: 'bad'.repeat(16), sandbox: true, allowLocal: true, tlds: ['com'] });
    await assert.rejects(wrong.quote({ domain: 'supplier-demo.com', operation: 'register' }));
  } finally { await proc.stop(); rmSync(dir, { recursive: true, force: true }); }
});
