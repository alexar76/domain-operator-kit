// Official unauthenticated disposable sandbox bootstrap. Never requests live keys.
import { existsSync, mkdirSync, writeFileSync, renameSync, mkdtempSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, dirname, join } from 'node:path';

if (process.env.DOMAIN_MODE !== 'sandbox' || process.env.DOMAIN_SANDBOX_PILOT !== '1') {
  throw Error('Requires DOMAIN_MODE=sandbox and DOMAIN_SANDBOX_PILOT=1');
}
const dir = resolve(process.env.PORKBUN_SANDBOX_KEY_DIR || join(homedir(), '.config/domain-kit/porkbun/temporary-sandbox'));
if (existsSync(dir)) throw Error('Credential directory already exists; reuse its API key and secret key. Nothing overwritten.');
const response = await fetch('https://api.porkbun.com/api/json/v3/apikey/request', {
  method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000), headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'domain-kit sandbox tests', sandbox: true }),
});
const data = await response.json();
if (!response.ok || data.status !== 'SUCCESS' || data.sandbox !== true ||
    !/^pk1_sb_[a-f0-9]+$/.test(data.apikey || '') || !/^sk1_sb_[a-f0-9]+$/.test(data.secretapikey || '')) {
  throw Error('Sandbox credential request was not confirmed. No credentials saved.');
}
mkdirSync(dirname(dir), { recursive: true, mode: 0o700 });
const temp = mkdtempSync(join(dirname(dir), '.porkbun-'));
writeFileSync(join(temp, 'api-key'), `${data.apikey}\n`, { mode: 0o600, flag: 'wx' });
writeFileSync(join(temp, 'secret-key'), `${data.secretapikey}\n`, { mode: 0o600, flag: 'wx' });
renameSync(temp, dir);
console.log(JSON.stringify({ sandbox: true, credentials_directory: dir, keys_printed: false }));
