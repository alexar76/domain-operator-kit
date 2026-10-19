import { Store, DomainService, demoProvider, demoPayments, signer, createHttpServer } from '../src/index.js';
import { DomainClient } from '../src/client.js';

const store = new Store(':memory:', Buffer.alloc(32, 1)), seller = signer(), owner = signer();
const service = new DomainService({ store, provider: demoProvider(store), payments: demoPayments(), signer: seller,
  origin: 'http://127.0.0.1', termsUrl: 'https://example.invalid/demo-terms' });
const server = createHttpServer(service);
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
service.origin = `http://127.0.0.1:${server.address().port}`;
const client = new DomainClient({ url: service.origin, sellerKey: seller.publicKey, productId: service.productId, ownerKey: owner, allowDemo: true, allowLocal: true, maxPurchaseUsd: '20' });
try {
  const quote = await client.call('quote', { domain: 'my-agent-demo.com' });
  const order = await client.call('register', { quote_id: quote.quote_id, client_order_id: 'demo-registration-0001', accept_terms: true, terms_version: quote.terms_version,
    registrant: { first_name: 'Demo', last_name: 'Buyer', email: 'buyer@example.net', phone_country: '+1', phone_number: '5551234567', street: 'Demo Street', number: '1', city: 'Example', postal_code: '12345', country: 'US' } });
  const dns = await client.call('dnsGet', { domain: order.domain });
  await client.call('dnsSet', { domain: order.domain, revision: dns.revision, records: [{ name: order.domain, type: 'A', value: '192.0.2.1', ttl: 900 }] });
  const renewal = await client.call('quote', { domain: order.domain, operation: 'renew' });
  const renewed = await client.call('renew', { quote_id: renewal.quote_id, client_order_id: 'demo-renewal-00000001', accept_terms: true, terms_version: renewal.terms_version });
  console.log(JSON.stringify({ mode: 'DEMO — no real domain, payment or DNS change', domain: order.domain, registration_price: quote.price_usd,
    fixed_markup: quote.markup_usd, registration: order.status, dns: 'updated in simulator', renewal: renewed.status, receipt_signed: Boolean(renewed.receipt_signature) }, null, 2));
} finally { await new Promise(resolve => server.close(resolve)); store.close(); }
