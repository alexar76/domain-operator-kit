import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Store } from './store.js';
import { signer, secureUrl } from './core.js';
import { demoProvider, httpProvider, openprovider, rdapAvailability } from './providers.js';
import { porkbun } from './porkbun.js';
import { cdpPayments, demoPayments } from './payments.js';
import { DomainService } from './service.js';

const secretFile = name => readFileSync(name, 'utf8').trim();
function once(path, make) { if (!existsSync(path)) writeFileSync(path, make(), { flag: 'wx', mode: 0o600 }); return secretFile(path); }
const filled = (env, name) => { try { return Boolean(env[name]) && readFileSync(env[name], 'utf8').trim().length > 0; } catch { return false; } };

/**
 * DOMAIN_MODE=auto: a node runs as a public demo until the operator has put in everything live
 * needs, then sells. Production registrar keys only (sandbox keys belong to DOMAIN_MODE=sandbox);
 * Porkbun stays sandbox-only. Returns the setting NAMES still missing, never their values.
 */
export function liveReadiness(env) {
  const missing = [];
  const provider = env.DOMAIN_PROVIDER || (env.OPENPROVIDER_USERNAME_FILE ? 'openprovider' : env.DOMAIN_SUPPLIER_URL ? 'http' : null);
  if (provider === 'openprovider') {
    for (const n of ['OPENPROVIDER_USERNAME_FILE', 'OPENPROVIDER_PASSWORD_FILE']) if (!filled(env, n)) missing.push(n);
  } else if (provider === 'http') {
    if (!/^https:\/\//.test(env.DOMAIN_SUPPLIER_URL || '')) missing.push('DOMAIN_SUPPLIER_URL');
    if (!filled(env, 'DOMAIN_SUPPLIER_SECRET_FILE')) missing.push('DOMAIN_SUPPLIER_SECRET_FILE');
  } else if (provider === 'porkbun') missing.push('DOMAIN_PROVIDER (porkbun is sandbox-only)');
  else missing.push('OPENPROVIDER_USERNAME_FILE or DOMAIN_SUPPLIER_URL');
  if (!/^0x[0-9a-fA-F]{40}$/.test(env.PAY_TO || '')) missing.push('PAY_TO');
  for (const n of ['CDP_KEY_FILE', 'DOMAIN_REFUND_KEY_FILE']) if (!filled(env, n)) missing.push(n);
  for (const n of ['DOMAIN_PUBLIC_URL', 'DOMAIN_TERMS_URL']) if (!/^https:\/\//.test(env[n] || '')) missing.push(n);
  if (env.DOMAIN_UPSTREAM_COST_CONFIRMED !== '1') missing.push('DOMAIN_UPSTREAM_COST_CONFIRMED');
  return { provider, missing };
}

export async function configuredService(input = process.env) {
  let env = input, liveMissing = [];
  const auto = env.DOMAIN_MODE === 'auto';
  if (auto) {
    const ready = liveReadiness(env);
    liveMissing = ready.missing;
    // Until every live setting is in, the demo provider answers, whatever keys are already there.
    env = { ...env, DOMAIN_MODE: liveMissing.length ? 'demo' : 'live', DOMAIN_PROVIDER: liveMissing.length ? 'demo' : ready.provider };
  }
  const mode = env.DOMAIN_MODE || 'demo';
  if (!['demo', 'sandbox', 'live'].includes(mode)) throw Error('DOMAIN_MODE must be demo, sandbox, live or auto');
  // A public demo (auto mode) refuses orders and answers real availability; the local demo simulates both.
  const demoOrders = (env.DOMAIN_DEMO_ORDERS || (auto ? 'refuse' : 'simulate')) !== 'refuse';
  const availability = (env.DOMAIN_DEMO_AVAILABILITY || (auto ? 'rdap' : 'simulated')) === 'rdap' ? rdapAvailability() : null;
  const dir = resolve(env.DOMAIN_DATA_DIR || './data'); mkdirSync(dir, { recursive: true, mode: 0o700 });
  const keyPath = env.DOMAIN_DATA_KEY_FILE || join(dir, 'encryption.key');
  const key = Buffer.from(once(keyPath, () => randomBytes(32).toString('hex')), 'hex');
  const signingKey = signer(once(env.DOMAIN_SIGNING_KEY_FILE || join(dir, 'provider.pem'), () => signer().pem));
  const origin = secureUrl(env.DOMAIN_PUBLIC_URL || 'http://127.0.0.1:9495', mode !== 'live');
  const termsUrl = mode === 'live' ? secureUrl(env.DOMAIN_TERMS_URL) : env.DOMAIN_TERMS_URL || 'https://example.invalid/demo-terms';
  if (mode === 'live' && env.DOMAIN_UPSTREAM_COST_CONFIRMED !== '1') throw Error('Confirm all-in USD supplier costs with DOMAIN_UPSTREAM_COST_CONFIRMED=1 before selling');
  const store = new Store(join(dir, 'orders.sqlite'), key);
  try {
    const tlds = (env.DOMAIN_TLDS || 'com,net,org').split(',').map(t => t.trim());
    if (tlds.some(t => !/^[a-z]{2,20}(\.[a-z]{2,20})?$/.test(t))) throw Error('invalid DOMAIN_TLDS');
    const kind = env.DOMAIN_PROVIDER || (mode === 'demo' ? 'demo' : 'openprovider');
    let provider;
    if (kind === 'demo') provider = demoProvider(store, { availability });
    else if (kind === 'openprovider') {
      if (tlds.some(t => !['com', 'net', 'org'].includes(t))) throw Error('Openprovider v1 supports com/net/org only; additional TLD policies need an adapter extension');
      provider = openprovider({ username: secretFile(env.OPENPROVIDER_USERNAME_FILE), password: secretFile(env.OPENPROVIDER_PASSWORD_FILE), sandbox: mode !== 'live', tlds, store });
    } else if (kind === 'porkbun') {
      provider = porkbun({ apiKey: secretFile(env.PORKBUN_API_KEY_FILE), secretKey: secretFile(env.PORKBUN_SECRET_KEY_FILE), sandbox: mode !== 'live', tlds, store });
    } else if (kind === 'http') provider = httpProvider({ url: env.DOMAIN_SUPPLIER_URL, secret: secretFile(env.DOMAIN_SUPPLIER_SECRET_FILE), tlds, sandbox: mode !== 'live',
      features: (env.DOMAIN_SUPPLIER_FEATURES || 'register,renew,info').split(','), allowLocal: mode !== 'live' });
    else throw Error('unknown DOMAIN_PROVIDER');
    const payments = mode === 'live' ? await cdpPayments({ cdpKeyFile: env.CDP_KEY_FILE, refundKeyFile: env.DOMAIN_REFUND_KEY_FILE,
      payTo: env.PAY_TO, rpcUrl: env.BASE_RPC, maxRefundUsd: env.DOMAIN_REFUND_MAX_USD || '100.00', dailyRefundUsd: env.DOMAIN_REFUND_DAILY_USD || '500.00' }) : demoPayments();
    return new DomainService({ store, provider, payments, signer: signingKey, origin, mode,
      productId: env.DOMAIN_PRODUCT_ID || 'domains-operator', sellerName: env.DOMAIN_SELLER_NAME || 'Domain operator',
      markupUsd: env.DOMAIN_MARKUP_USD || '2.00', termsUrl, termsVersion: env.DOMAIN_TERMS_VERSION || '1', demoOrders, liveMissing });
  } catch (error) { store.close(); throw error; }
}
