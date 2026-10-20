import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitForSetup } from '../src/setup-readiness.js';

function fixture() {
  let time = 0;
  const progress = [];
  const options = {
    getDomain: async () => ({ verified: true }),
    verifyDomain: async () => ({ verified: true }),
    getConfig: async () => ({ misconfigured: false }),
    ensureCertificate: async () => ({ id: 'cert-test' }),
    checkHttps: async () => ({ status: 200, apiHealth: { status: 200 } }),
    now: () => time, sleep: async ms => { time += ms; },
    timeoutMs: 100, intervalMs: 20, onProgress: state => { progress.push(state); },
  };
  return { options, progress };
}
test('waits through DNS, certificate and TLS propagation before marking ready', async () => {
  const f = fixture();
  let dns = 0, cert = 0, https = 0;
  f.options.getConfig = async () => ({ misconfigured: ++dns === 1 });
  f.options.ensureCertificate = async () => ++cert === 1 ? { pending: true } : { id: 'cert' };
  f.options.checkHttps = async () => {
    if (++https === 1) throw new TypeError('fetch failed');
    return { status: 200, apiHealth: { status: 200 } };
  };
  const result = await waitForSetup(f.options);
  assert.equal(result.status, 'ready');
  assert.deepEqual(f.progress.map(s => s.status), ['waiting_for_dns', 'waiting_for_certificate', 'waiting_for_https', 'ready']);
});
test('timeout stays pending and can resume without a purchase callback', async () => {
  const f = fixture();
  f.options.getConfig = async () => ({ misconfigured: true });
  const pending = await waitForSetup(f.options);
  assert.equal(pending.status, 'waiting_for_dns');
  assert.equal(pending.timedOut, true);
  assert.equal(pending.resumable, true);
  assert.equal(pending.elapsedMs, 100);
  assert.ok(f.progress.every(s => s.status !== 'ready'));
  f.options.getConfig = async () => ({ misconfigured: false });
  assert.equal((await waitForSetup(f.options)).status, 'ready');
});
test('verification may be pending; application health must pass separately', async () => {
  const f = fixture();
  let verified = false, healthCalls = 0;
  f.options.getDomain = async () => ({ verified });
  f.options.verifyDomain = async () => {
    verified = true;
    throw Object.assign(Error('dns not propagated'), { status: 400 });
  };
  f.options.checkHttps = async () => {
    if (++healthCalls === 1) throw Error('sentinel_api_health_failed');
    return { status: 200 };
  };
  const result = await waitForSetup(f.options);
  assert.equal(result.status, 'ready');
  assert.deepEqual(f.progress.map(s => s.status), ['waiting_for_dns', 'waiting_for_application', 'ready']);
});
test('transient provider errors are retried but access failures require attention', async () => {
  const f = fixture();
  let calls = 0;
  f.options.getConfig = async () => {
    if (++calls === 1) throw Object.assign(Error('temporary'), { status: 503 });
    return { misconfigured: false };
  };
  assert.equal((await waitForSetup(f.options)).status, 'ready');
  assert.equal(f.progress[0].status, 'waiting_for_provider');
  f.options.getDomain = async () => { throw Object.assign(Error('access_denied'), { status: 403 }); };
  await assert.rejects(waitForSetup(f.options), /access_denied/);
  assert.equal(f.progress.at(-1).status, 'needs_attention');
});
