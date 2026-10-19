import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

function bootstrap(dir, result, mode = 'sandbox') {
  const preload = `globalThis.fetch = async (url, options) => {
    if (url !== 'https://api.porkbun.com/api/json/v3/apikey/request' || JSON.parse(options.body).sandbox !== true) throw Error('unexpected request');
    return new Response(JSON.stringify(${JSON.stringify(result)}));
  };`;
  return spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, 'scripts/porkbun-sandbox.mjs'], {
    encoding: 'utf8', env: { ...process.env, DOMAIN_MODE: mode, DOMAIN_SANDBOX_PILOT: '1', PORKBUN_SANDBOX_KEY_DIR: dir },
  });
}
const pair = { status: 'SUCCESS', sandbox: true, apikey: 'pk1_sb_1234', secretapikey: 'sk1_sb_abcd' };
test('Porkbun sandbox bootstrap saves both keys privately without printing or overwriting them', () => {
  const parent = mkdtempSync(join(tmpdir(), 'porkbun-init-')), dir = join(parent, 'credentials');
  try {
    const r = bootstrap(dir, pair); assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(join(dir, 'api-key'), 'utf8').trim(), pair.apikey);
    assert.equal(readFileSync(join(dir, 'secret-key'), 'utf8').trim(), pair.secretapikey);
    assert.equal(statSync(dir).mode & 0o777, 0o700); assert.equal(statSync(join(dir, 'secret-key')).mode & 0o777, 0o600);
    assert.ok(!`${r.stdout}${r.stderr}`.includes(pair.secretapikey));
    assert.notEqual(bootstrap(dir, pair).status, 0);
    assert.equal(readFileSync(join(dir, 'api-key'), 'utf8').trim(), pair.apikey);
  } finally { rmSync(parent, { recursive: true }); }
});
test('Porkbun sandbox bootstrap refuses live mode, live keys and an unconfirmed sandbox response', () => {
  const parent = mkdtempSync(join(tmpdir(), 'porkbun-init-')), dir = join(parent, 'credentials');
  try {
    for (const [data, mode] of [[pair, 'live'], [{ ...pair, sandbox: false }, 'sandbox'], [{ ...pair, secretapikey: 'sk1_live' }, 'sandbox']]) {
      assert.notEqual(bootstrap(dir, data, mode).status, 0); assert.equal(existsSync(dir), false);
    }
  } finally { rmSync(parent, { recursive: true }); }
});
