import { test } from 'node:test';
import assert from 'node:assert/strict';
import { privateKeyToAccount } from 'viem/accounts';
import { recoverTypedDataAddress } from 'viem';
import { authorizationTypes } from '@x402/evm';
import { x402PaymentSigner } from '../src/client.js';
import { cdpPayments, termsFor, inspectPayment, verifyPaymentOrder, USDC } from '../src/payments.js';

test('installed x402 SDK signs genuine Base USDC authorization and refund to original payer', async () => {
  // Public test fixtures; never funded or used outside this test.
  const buyerKey = `0x${'01'.repeat(32)}`, refundAccount = privateKeyToAccount(`0x${'02'.repeat(32)}`);
  const buyer = privateKeyToAccount(buyerKey), payTo = `0x${'03'.repeat(20)}`;
  const sign = await x402PaymentSigner(buyerKey, '20.00'), terms = termsFor('12.50', payTo);
  const payload = await sign({ x402Version: 2, resource: { url: 'https://seller.example/register' }, accepts: [terms], order_id: 'order-1',
    domain_order_binding: { protocol: 'domain-payment-order/1', origin: 'https://seller.example', owner: 'owner-1' } });
  const inspected = inspectPayment(Buffer.from(JSON.stringify(payload)).toString('base64'), terms);
  assert.equal(inspected.payer, buyer.address.toLowerCase());
  const recover = p => recoverTypedDataAddress({ domain: { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: USDC },
    primaryType: 'TransferWithAuthorization', types: authorizationTypes, message: p.payload.authorization, signature: p.payload.signature });
  assert.equal(await recover(payload), buyer.address);
  await verifyPaymentOrder(payload, 'https://seller.example', 'order-1', 'owner-1');
  await assert.rejects(verifyPaymentOrder(payload, 'https://seller.example', 'order-1', 'another-owner'), { code: 'payment_order_binding_invalid' });
  await assert.rejects(verifyPaymentOrder(payload, 'https://seller.example', 'another-order', 'owner-1'), { code: 'payment_order_binding_invalid' });
  const adapter = await cdpPayments({ payTo, account: refundAccount,
    facilitator: { verify: async () => ({ isValid: true }), settle: async () => ({ success: true, transaction: `0x${'04'.repeat(32)}`, network: 'eip155:8453' }) },
    reconciler: { prepare: async () => ({}), resolve: async () => ({ status: 'pending' }) } });
  const refund = await adapter.refundPayload({ id: 'test', price_usd: '12.50', payment: { payer: buyer.address } }, 'https://seller.example');
  assert.equal(refund.terms.amount, '12500000'); assert.equal(refund.terms.payTo, buyer.address);
  assert.equal(await recover(refund.payload), refundAccount.address);
  inspectPayment(Buffer.from(JSON.stringify(refund.payload)).toString('base64'), refund.terms);
});
