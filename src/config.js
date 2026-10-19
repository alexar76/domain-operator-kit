import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Store } from './store.js';
import { signer, secureUrl } from './core.js';
import { demoProvider, httpProvider, openprovider } from './providers.js';
import { porkbun } from './porkbun.js';
import { cdpPayments, demoPayments } from './payments.js';
import { DomainService } from './service.js';

const secretFile = name => readFileSync(name, 'utf8').trim();
function once(path, make) { if (!existsSync(path)) writeFileSync(path, make(), { flag: 'wx', mode: 0o600 }); return secretFile(path); }
export async function configuredService(env = process.env) {
  const mode = env.DOMAIN_MODE || 'demo';
  if (!['demo', 'sandbox', 'live'].includes(mode)) throw Error('DOMAIN_MODE must be demo, sandbox or live');
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
    if (kind === 'demo') provider = demoProvider(store);
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
      markupUsd: env.DOMAIN_MARKUP_USD || '2.00', termsUrl, termsVersion: env.DOMAIN_TERMS_VERSION || '1' });
  } catch (error) { store.close(); throw error; }
}
