import { canonical, digest, ownerHeaders, verifySignature, secureUrl, units, fail } from './core.js';
import { CONTRACT } from './contract.js';
import { inspectPayment, paymentOrderMessage } from './payments.js';

// A caller pins the seller key from a trusted catalogue. Neither model arguments nor seller
// responses can change the payment destination, budget or owner signing key configuration.
export class DomainClient {
  constructor({ url, sellerKey, productId, ownerKey, fetchImpl = fetch, paymentSigner = null, store = null,
    maxPurchaseUsd = '0', dailyBudgetUsd = '0', allowLocal = false, allowDemo = false, now = () => Date.now() }) {
    this.url = secureUrl(url, allowLocal);
    if (!/^[A-Za-z0-9+/]{43}=$/.test(sellerKey || '') || !productId) throw Error('Pinned sellerKey and productId required');
    units(maxPurchaseUsd); units(dailyBudgetUsd);
    if (paymentSigner && !store) throw Error('Paid client requires a durable store');
    Object.assign(this, { sellerKey, productId, ownerKey, fetchImpl, paymentSigner, store, maxPurchaseUsd, dailyBudgetUsd, allowDemo, now });
  }
  async call(key, input) {
    const route = CONTRACT.find(c => c.key === key); if (!route) throw Error('Unknown capability');
    if (['register', 'renew'].includes(key) && units(this.maxPurchaseUsd) === 0n) fail('purchases_disabled', 403);
    const send = async header => {
      const headers = { 'content-type': 'application/json',
        ...(!route.public || input.operation === 'renew' ? ownerHeaders(this.ownerKey, this.url, route.path, input, this.now()) : {}),
        ...(header ? { 'payment-signature': header } : {}) };
      const res = await this.fetchImpl(`${this.url}${route.path}`, { method: 'POST', headers, body: canonical(input), redirect: 'error', signal: AbortSignal.timeout(90000) });
      const body = await res.json();
      if (body.result) {
        const bound = { capability_id: route.capability_id, product_id: this.productId, input_sha256: digest(input), result: body.result };
        if (!verifySignature(this.sellerKey, canonical(bound), res.headers.get('x-provider-signature') || '')) fail('invalid_seller_signature', 502);
        if (body.result.mode && body.result.mode !== 'live' && !this.allowDemo) fail('test_seller_refused', 409);
      }
      if (!res.ok && res.status !== 402) throw Object.assign(Error(body.error || 'seller_failed'), { code: body.error });
      if (!body.result) fail(body.error || 'invalid_seller_response', 502);
      return { status: res.status, body };
    };
    const reference = digest({ seller: this.url, owner: this.ownerKey?.publicKey, key, input });
    const existing = this.store?.get('buyer-payments', reference);
    let response = await send(existing?.header);
    if (response.status !== 402) return response.body.result;
    if (existing) fail('existing_payment_requires_reconciliation', 409);
    if (!this.paymentSigner) return response.body.result;
    const required = response.body.result?.payment_required;
    const terms = required?.accepts?.[0];
    if (required?.order_id !== digest(`${this.ownerKey.publicKey}:${input.client_order_id}`)
      || required?.domain_order_binding?.owner !== this.ownerKey.publicKey || required?.domain_order_binding?.origin !== this.url) fail('payment_order_binding_invalid', 402);
    if (!terms || required.accepts.length !== 1 || required.resource?.url !== `${this.url}${route.path}`
      || terms.scheme !== 'exact' || terms.network !== 'eip155:8453' || terms.asset?.toLowerCase() !== '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
      || !/^0x[0-9a-f]{40}$/i.test(terms.payTo || '') || !/^\d+$/.test(terms.amount || '')
      || BigInt(terms.amount) > units(this.maxPurchaseUsd) || BigInt(terms.amount) <= 0n) fail('buyer_budget_or_terms_refused', 403);
    // Reserve budget BEFORE signing, and retain it on ambiguous outcomes. No retries can mint a
    // fresh authorization for the same purchase. Private payload is encrypted by the Store.
    const day = new Date(this.now()).toISOString().slice(0, 10);
    this.store.transaction(() => {
      if (this.store.get('buyer-payments', reference)) fail('buyer_payment_in_progress', 409);
      const budget = this.store.get('buyer-budget', day) || { units: '0' };
      const total = BigInt(budget.units) + BigInt(terms.amount);
      if (total > units(this.dailyBudgetUsd)) fail('buyer_daily_budget_exceeded', 403);
      this.store.put('buyer-budget', day, { units: total.toString() });
      this.store.put('buyer-payments', reference, { status: 'signing', amount: terms.amount });
    });
    const payload = await this.paymentSigner(required);
    const header = Buffer.from(JSON.stringify(payload)).toString('base64');
    inspectPayment(header, terms, this.now());
    this.store.put('buyer-payments', reference, { status: 'authorized', header, amount: terms.amount });
    response = await send(header);
    return response.body.result;
  }
}

export async function x402PaymentSigner(privateKey, maxAmountUsd = '0') {
  const [{ privateKeyToAccount }, { x402Client }, { ExactEvmScheme }] = await Promise.all([import('viem/accounts'), import('@x402/core/client'), import('@x402/evm')]);
  const account = privateKeyToAccount(privateKey);
  const client = new x402Client().register('eip155:8453', new ExactEvmScheme(account))
    .setSpendControls({ maxAmountPerPayment: '0', allowedAssets: [{ network: 'eip155:8453', asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', maxAmountPerPayment: units(maxAmountUsd).toString() }] });
  return async requirements => {
    const b = requirements.domain_order_binding;
    if (b?.protocol !== 'domain-payment-order/1' || !requirements.order_id || !b.owner || !b.origin) fail('payment_order_binding_required');
    const payload = await client.createPaymentPayload(requirements);
    payload.domainOrderProof = await account.signMessage({ message: paymentOrderMessage(b.origin, requirements.order_id, b.owner, payload.payload.authorization.nonce) });
    return payload;
  };
}
