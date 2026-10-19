import { CAPS } from './service.js';
const string = { type: 'string' };
const object = (properties, required) => ({ type: 'object', additionalProperties: false, properties, required });
export const CONTACT = object(Object.fromEntries(['first_name', 'last_name', 'company', 'email', 'phone_country', 'phone_area', 'phone_number', 'street', 'number', 'city', 'state', 'postal_code', 'country'].map(k => [k, string])),
  ['first_name', 'last_name', 'email', 'phone_country', 'phone_number', 'street', 'number', 'city', 'postal_code', 'country']);
const purchase = { quote_id: string, client_order_id: { type: 'string', minLength: 16, maxLength: 80 }, accept_terms: { const: true }, terms_version: string };
export const CONTRACT = [
  { key: 'quote', path: '/quote', public: true, description: 'Quote a one-year domain registration or renewal. Renewal requires the owner signature. Availability is not a reservation.',
    input: object({ domain: { type: 'string', description: 'Exact registrable ASCII domain, e.g. example.com' }, operation: { enum: ['register', 'renew'], default: 'register' }, period_years: { const: 1 } }, ['domain']) },
  { key: 'register', path: '/register', description: 'Buy the exact domain in an unexpired quote, registered to the supplied registrant. Irreversible after registration. Separate x402 payment required.',
    input: object({ ...purchase, registrant: CONTACT }, [...Object.keys(purchase), 'registrant']) },
  { key: 'renew', path: '/renew', description: 'Renew an owned domain for one year using a renewal quote. Separate payment; automatic registrar renewal is disabled.', input: object(purchase, Object.keys(purchase)) },
  { key: 'status', path: '/status', description: 'Recover a private order after a lost response. Pending is not failure; never buy again to resolve a timeout.', input: object({ order_id: string }, ['order_id']) },
  { key: 'info', path: '/info', description: 'Read an owned domain, expiry, nameservers and verification requirements.', input: object({ domain: string }, ['domain']) },
  { key: 'dnsGet', path: '/dns/get', feature: 'dns', description: 'Read owned DNS records and their revision before an update.', input: object({ domain: string }, ['domain']) },
  { key: 'dnsSet', path: '/dns/set', feature: 'dns', description: 'Replace only named DNS record sets, preserving other names and types. Requires the current DNS revision.', input: object({ domain: string, revision: string, records: { type: 'array', minItems: 1, maxItems: 50, items: object({ name: string, type: { enum: ['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'CAA'] }, value: string, ttl: { type: 'integer', minimum: 60, maximum: 86400 }, prio: { type: 'integer', minimum: 0, maximum: 65535 } }, ['name', 'type', 'value', 'ttl']) } }, ['domain', 'revision', 'records']) },
  { key: 'transferCode', path: '/transfer-code', feature: 'transfer_code', description: 'Retrieve the secret transfer code of an owned domain. Registrar locks still apply. Do not publish this result.', input: object({ domain: string }, ['domain']) },
].map(c => ({ ...c, capability_id: CAPS[c.key] }));

export function listing(service) {
  const available = CONTRACT.filter(c => !c.feature || service.provider.features.includes(c.feature));
  const quote = available[0];
  return { protocol: 'domains/v1', mode: service.mode, seller: { product_id: service.productId, name: service.sellerName, provider_pubkey: service.signer.publicKey },
    provider: { kind: service.provider.kind, tlds: service.provider.tlds },
    pricing: { fixed_markup_usd: service.markupUsd, hub_commission_usd: '0', per: 'registration or renewal order' },
    listings: [{ capability_id: CAPS.quote, product_id: service.productId, publisher_id: service.productId, provider_pubkey: service.signer.publicKey,
      version: 'v1', name: `${service.sellerName} — domains`, description: `${service.mode === 'live' ? '' : 'TEST SELLER; no real domains or payments. '}${quote.description}`,
      invoke_url: `${service.origin}/quote/invoke`, price_per_call_usd: 0,
      input_schema: object({ domain: quote.input.properties.domain }, ['domain']), output_schema: { type: 'object' } }],
    capabilities: available.map(c => ({ capability_id: c.capability_id, description: c.description, url: `${service.origin}${c.path}`, method: 'POST',
      direct_only: !c.public, owner_auth: !c.public ? 'domain-owner/1' : 'required for renew', input_schema: c.input,
      payment: ['register', 'renew'].includes(c.key) ? (service.mode === 'live' ? 'x402-v2 USDC Base' : 'simulation') : 'free' })),
  };
}

export function nodeToml(service, nodeUrl, upstream = 'http://127.0.0.1:9495') {
  const q = JSON.stringify;
  return `# Generated domain federation node. Only public quotes go through Hub.\nname = ${q(service.sellerName)}\ndescription = ${q(`${service.mode === 'live' ? '' : 'TEST ONLY. '}Domain registration quotes; direct seller orders and private owner management.`)}\nurl = ${q(nodeUrl)}\nupstream = ${q(upstream)}\n\n[[capability]]\nid = "domains.quote@v1"\nproduct = ${q(service.productId)}\nname = "Domain registration quotes"\ndescription = "Exact domain availability and one-year price. Quote is not a reservation. Buy directly at order_url; private owner data never goes through Hub."\nprice_usd = 0\nmethod = "POST"\npath = "/quote"\nprovider_pubkey = ${q(service.signer.publicKey)}\ninput_schema = { type = "object", required = ["domain"], additionalProperties = false, properties = { domain = { type = "string", description = "An exact registrable domain, e.g. example.com" } } }\n`;
}
