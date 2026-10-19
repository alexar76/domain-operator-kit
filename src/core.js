import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, randomBytes } from 'node:crypto';
import { domainToASCII } from 'node:url';

export class DomainError extends Error {
  constructor(code, status = 400, message = code) { super(message); this.code = code; this.status = status; }
}
export const fail = (code, status = 400) => { throw new DomainError(code, status); };
export const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`
  : JSON.stringify(value ?? null);
export const digest = value => createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');
export const token = () => randomBytes(24).toString('base64url');
export const object = v => Boolean(v && typeof v === 'object' && !Array.isArray(v));
export function only(input, keys) {
  if (!object(input) || Object.keys(input).some(k => !keys.includes(k))) fail('invalid_fields');
}
export function units(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,8})(\.\d{1,6})?$/.test(value)) fail('invalid_money');
  const [a, b = ''] = value.split('.'); return BigInt(a) * 1000000n + BigInt(b.padEnd(6, '0'));
}
export function dollars(value) {
  const n = BigInt(value); if (n < 0n) fail('invalid_money');
  return `${n / 1000000n}.${String(n % 1000000n).padStart(6, '0')}`;
}
export function domainName(value) {
  if (typeof value !== 'string' || value !== value.trim() || /[\s/@:#?\\]/u.test(value)) fail('invalid_domain');
  const name = domainToASCII(value.toLowerCase());
  if (!name || name.length > 253 || !name.includes('.') || name.split('.').some(l => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l))) fail('invalid_domain');
  return name;
}
export function splitDomain(value, tlds) {
  const domain = domainName(value);
  const extension = [...tlds].sort((a, b) => b.length - a.length).find(tld => domain.endsWith(`.${tld}`));
  if (!extension) fail('unsupported_tld', 422);
  const name = domain.slice(0, -extension.length - 1);
  if (name.includes('.')) fail('registrable_domain_required');
  // First release makes IDN display/registry requirements explicit instead of accepting ambiguous names.
  if (name.startsWith('xn--')) fail('idn_not_supported', 422);
  return { domain, name, extension };
}
export function registrant(input) {
  only(input, ['first_name', 'last_name', 'company', 'email', 'phone_country', 'phone_area', 'phone_number', 'street', 'number', 'city', 'state', 'postal_code', 'country']);
  for (const field of ['first_name', 'last_name', 'email', 'phone_country', 'phone_number', 'street', 'number', 'city', 'postal_code', 'country']) {
    if (typeof input[field] !== 'string' || !input[field].trim() || input[field].length > 200 || /[\x00-\x1f\x7f]/.test(input[field])) fail(`invalid_registrant_${field}`);
  }
  for (const value of Object.values(input)) if (typeof value !== 'string' || value.length > 200 || /[\x00-\x1f\x7f]/.test(value)) fail('invalid_registrant');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email) || !/^[A-Z]{2}$/.test(input.country)
    || !/^\+\d{1,3}$/.test(input.phone_country) || !/^\d{4,15}$/.test(input.phone_number)
    || (input.phone_area && !/^\d{1,6}$/.test(input.phone_area))) fail('invalid_registrant');
  return input;
}
export function signer(pem) {
  const key = pem ? createPrivateKey(pem) : generateKeyPairSync('ed25519').privateKey;
  if (key.asymmetricKeyType !== 'ed25519') fail('ed25519_required');
  return { pem: key.export({ format: 'pem', type: 'pkcs8' }),
    publicKey: createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64'),
    sign: value => sign(null, Buffer.from(typeof value === 'string' ? value : canonical(value)), key).toString('base64') };
}
export function verifySignature(publicKey, value, signature) {
  try {
    if (!/^[A-Za-z0-9+/]{43}=$/.test(publicKey) || !/^[A-Za-z0-9+/]{86}==$/.test(signature)) return false;
    const key = createPublicKey({ format: 'der', type: 'spki', key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(publicKey, 'base64')]) });
    return verify(null, Buffer.from(typeof value === 'string' ? value : canonical(value)), key, Buffer.from(signature, 'base64'));
  } catch { return false; }
}
export const requestProof = (origin, path, body, timestamp, nonce) => canonical({ v: 1, audience: origin, method: 'POST', path, body_sha256: digest(body), timestamp, nonce });
export function ownerHeaders(key, origin, path, body, now = Date.now()) {
  const timestamp = String(Math.floor(now / 1000)), nonce = token();
  return { 'x-domain-owner': key.publicKey, 'x-domain-time': timestamp, 'x-domain-nonce': nonce,
    'x-domain-signature': key.sign(requestProof(origin, path, body, timestamp, nonce)) };
}
export function authenticate(headers, origin, path, body, store, now = Date.now()) {
  const owner = headers['x-domain-owner'], timestamp = headers['x-domain-time'], nonce = headers['x-domain-nonce'];
  if (!/^\d{10,12}$/.test(timestamp || '') || Math.abs(now / 1000 - Number(timestamp)) > 300
    || !/^[A-Za-z0-9_-]{32}$/.test(nonce || '') || !verifySignature(owner || '', requestProof(origin, path, body, timestamp, nonce), headers['x-domain-signature'] || '')) fail('owner_auth_required', 401);
  if (!store.consumeNonce(digest(`${owner}:${nonce}`), now)) fail('request_replayed', 409);
  return owner;
}
export function secureUrl(value, allowLocal = false) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(allowLocal && url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) fail('https_required');
  return url.href.replace(/\/$/, '');
}
