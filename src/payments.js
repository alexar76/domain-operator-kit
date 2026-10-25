import { readFileSync } from 'node:fs';
import { fail, digest, canonical, units, secureUrl } from './core.js';
import { createBaseReconciler } from './payments/reconcile.js';

export const NETWORK = 'eip155:8453';
export const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const paymentOrderMessage = (origin, orderId, owner, nonce) => canonical({ protocol: 'domain-payment-order/1', origin, order_id: orderId, owner, nonce });
const standardPayload = payload => { const { domainOrderProof: _proof, ...standard } = payload; return standard; };
export async function verifyPaymentOrder(payload, origin, orderId, owner) {
  const { recoverMessageAddress } = await import('viem');
  try {
    const address = await recoverMessageAddress({ message: paymentOrderMessage(origin, orderId, owner, payload.payload.authorization.nonce), signature: payload.domainOrderProof });
    if (address.toLowerCase() !== payload.payload.authorization.from.toLowerCase()) throw Error();
  } catch { fail('payment_order_binding_invalid', 402); }
}
const addr = /^0x[0-9a-f]{40}$/i, hash = /^0x[0-9a-f]{64}$/i;
export const termsFor = (amount, payTo) => ({ scheme: 'exact', network: NETWORK, amount: units(amount).toString(),
  asset: USDC, payTo, maxTimeoutSeconds: 300, extra: { name: 'USD Coin', version: '2' } });

export function inspectPayment(header, terms, now = Date.now()) {
  let payload;
  try { if (!header || header.length > 16000) throw Error(); payload = JSON.parse(Buffer.from(header, 'base64').toString()); }
  catch { fail('invalid_payment', 402); }
  const a = payload?.payload?.authorization, accepted = payload?.accepted;
  if (payload.x402Version !== 2 || !a || !addr.test(a.from) || !addr.test(a.to) || !hash.test(a.nonce)
    || !/^\d+$/.test(String(a.value)) || !/^\d+$/.test(String(a.validAfter)) || !/^\d+$/.test(String(a.validBefore))
    || typeof payload.payload.signature !== 'string' || !/^0x[0-9a-f]{130}$/i.test(payload.payload.signature)
    || a.to.toLowerCase() !== terms.payTo.toLowerCase() || String(a.value) !== terms.amount
    || Number(a.validAfter) > now / 1000 || Number(a.validBefore) <= now / 1000
    || Number(a.validBefore) > now / 1000 + 600
    || !accepted || accepted.scheme !== terms.scheme || accepted.network !== terms.network
    || accepted.asset?.toLowerCase() !== terms.asset.toLowerCase() || accepted.payTo?.toLowerCase() !== terms.payTo.toLowerCase()
    || accepted.amount !== terms.amount) fail('payment_terms_mismatch', 402);
  return { payload, payer: a.from.toLowerCase(), reference: `${a.from.toLowerCase()}:${a.nonce.toLowerCase()}`, fingerprint: digest(payload) };
}

export async function cdpPayments({ cdpKeyFile, payTo, refundKeyFile, rpcUrl, maxRefundUsd = '100.00', dailyRefundUsd = '500.00', facilitator, account, reconciler }) {
  if (!addr.test(payTo)) throw Error('PAY_TO must be a Base wallet address');
  if (!facilitator) {
    const credentials = JSON.parse(readFileSync(cdpKeyFile, 'utf8'));
    const { createCdpFacilitatorClient } = await import('@aimarket/x402-cdp');
    facilitator = createCdpFacilitatorClient({ apiKeyId: credentials.id, apiKeySecret: credentials.privateKey });
  }
  if (!account) {
    const { privateKeyToAccount } = await import('viem/accounts');
    account = privateKeyToAccount(readFileSync(refundKeyFile, 'utf8').trim());
  }
  const [{ x402Client }, { ExactEvmScheme }] = await Promise.all([import('@x402/core/client'), import('@x402/evm')]);
  const client = new x402Client().register(NETWORK, new ExactEvmScheme(account))
    .setSpendControls({ maxAmountPerPayment: '0', allowedAssets: [{ network: NETWORK, asset: USDC, maxAmountPerPayment: units(maxRefundUsd).toString() }] });
  const reader = reconciler || createBaseReconciler({ ...(rpcUrl ? { rpcUrl: secureUrl(rpcUrl) } : {}) });
  units(maxRefundUsd); units(dailyRefundUsd);
  return { kind: 'x402', payTo, maxRefundUsd, dailyRefundUsd, refundAddress: account.address,
    terms: amount => termsFor(amount, payTo), inspect: inspectPayment,
    verifyOrder: verifyPaymentOrder,
    async verify(payload, terms) { const v = await facilitator.verify(standardPayload(payload), terms); if (!v?.isValid) fail('payment_refused', 402); },
    prepareProof: (payload, terms) => reader.prepare(payload.payload.authorization, { to: terms.payTo, value: terms.amount }),
    async settle(payload, terms) {
      const result = await facilitator.settle(standardPayload(payload), terms);
      if (!result?.success || !hash.test(result.transaction || '') || result.network !== NETWORK) throw Error('settlement_uncertain');
      return { transaction: result.transaction, network: NETWORK, payer: payload.payload.authorization.from, success: true };
    },
    reconcile: proof => reader.resolve(proof),
    async refundPayload(order, origin) {
      if (order.payment.payer.toLowerCase() === account.address.toLowerCase()) fail('refund_wallet_is_payer', 409);
      const terms = termsFor(order.price_usd, order.payment.payer);
      const payload = await client.createPaymentPayload({ x402Version: 2, resource: { url: `${origin}/refund/${order.id}`, description: 'Refund of undelivered domain order', mimeType: 'application/json' }, accepts: [terms] });
      return { payload, terms };
    },
  };
}

export function demoPayments() {
  return { kind: 'demo', payTo: null, maxRefundUsd: '100.00', dailyRefundUsd: '500.00', refundAddress: 'demo',
    terms: amount => ({ demo: true, amount }),
    inspect: (_header, _terms, _now, orderId) => ({ payer: 'demo', reference: `demo:${orderId}`, fingerprint: 'demo', payload: {} }),
    verify: async () => {}, prepareProof: async () => ({ demo: true }),
    settle: async () => ({ success: true, transaction: 'demo-not-onchain' }),
    reconcile: async () => ({ status: 'pending' }),
    refundPayload: async () => ({ payload: {}, terms: {} }),
  };
}
