import { canonical, digest, token, units, dollars, only, fail, registrant, splitDomain, DomainError } from './core.js';
import { validateRecords } from './dns.js';

export const CAPS = { quote: 'domains.quote@v1', register: 'domains.register@v1', renew: 'domains.renew@v1',
  status: 'domains.order.status@v1', info: 'domains.info@v1', dnsGet: 'domains.dns.get@v1', dnsSet: 'domains.dns.set@v1', transferCode: 'domains.transfer.code@v1' };
const TERMINAL = new Set(['delivered', 'refunded', 'cancelled']);

export class DomainService {
  constructor({ store, provider, payments, signer, origin, productId = 'domains-operator', sellerName = 'Domain operator',
    markupUsd = '2.00', termsUrl, termsVersion = '1', now = () => Date.now(), quoteTtlMs = 300000, mode = 'demo',
    demoOrders = true, liveMissing = [] }) {
    if (!store || !provider || !payments || !signer || !origin) throw Error('store, provider, payments, signer and origin required');
    if (mode === 'live' && (provider.sandbox || payments.kind === 'demo')) throw Error('live mode requires real registrar and payment adapters');
    if (mode !== 'live' && payments.kind !== 'demo') throw Error('test modes cannot accept real payments');
    if (!Number.isInteger(quoteTtlMs) || quoteTtlMs < 1000 || quoteTtlMs > 600000) throw Error('invalid quote lifetime');
    units(markupUsd);
    Object.assign(this, { store, provider, payments, signer, origin, productId, sellerName, markupUsd, termsUrl, termsVersion, now, quoteTtlMs, mode, demoOrders, liveMissing });
    this.running = new Map();
    this.recovering = false;
    this.recoveryCursor = 0;
  }
  serial(key, fn) {
    const previous = this.running.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(fn); this.running.set(key, next);
    return next.finally(() => { if (this.running.get(key) === next) this.running.delete(key); });
  }
  /** A public demo seller: everything answers except buying (register, renew). */
  get refusesOrders() { return this.mode === 'demo' && !this.demoOrders; }
  audit(type, order) { this.store.put('audit', token(), { at: this.now(), type, order_id: order.id, state: order.state }); }
  save(order, state, extra = {}) {
    Object.assign(order, extra, { state, updated_at: this.now() });
    this.store.put('orders', order.id, order); this.audit(state, order); return order;
  }
  owned(domain, owner) {
    const record = this.store.get('domains', domain);
    if (!owner || !record || record.owner !== owner) fail('domain_not_found', 404);
    return record;
  }
  async quote(input, owner = null) {
    only(input, ['domain', 'operation', 'period_years']);
    const { domain } = splitDomain(input.domain, this.provider.tlds);
    const operation = input.operation ?? 'register';
    if (!['register', 'renew'].includes(operation) || (input.period_years !== undefined && input.period_years !== 1)) fail('unsupported_operation_or_period', 422);
    if (!this.provider.features.includes(operation)) fail('operation_not_supported', 422);
    const existing = operation === 'renew' ? this.owned(domain, owner) : null;
    if (existing) await this.provider.info(existing);
    const p = await this.provider.quote({ domain, operation, period_years: 1 });
    if (p.available === false) return { available: false, domain, mode: this.mode };
    if (p.available !== true || p.currency !== 'USD' || p.premium !== false || p.period_years !== 1) fail('unsupported_supplier_quote', 502);
    const total = units(p.cost_usd) + units(this.markupUsd), renewal = units(p.renewal_cost_usd) + units(this.markupUsd);
    if (total <= 0n) fail('invalid_supplier_price', 502);
    const q = { quote_id: token(), domain, operation, period_years: 1, cost_usd: dollars(units(p.cost_usd)), markup_usd: dollars(units(this.markupUsd)),
      price_usd: dollars(total), renewal_estimate_usd: dollars(renewal), renewal_price_guaranteed: false,
      currency: 'USDC', expires_at: new Date(this.now() + this.quoteTtlMs).toISOString(),
      seller: { product_id: this.productId, name: this.sellerName, provider_pubkey: this.signer.publicKey },
      owner: operation === 'renew' ? owner : null, based_on_expiry: existing?.expires_at || null,
      terms_version: this.termsVersion, terms_url: this.termsUrl,
      registration_requirements: ['registrant_contact', 'accept_terms', 'possible_registrant_email_verification'],
      domain_reserved: false, mode: this.mode, order_url: `${this.origin}/${operation}`,
      ...(this.refusesOrders ? { demo: { orders: 'refused with demo_mode', prices: 'illustrative', availability: this.provider.availability || 'simulated' } } : {}),
      payment_policy: 'Payment settles before irreversible registration. Definitive non-delivery is refunded; unknown outcomes are reconciled.' };
    this.store.put('quotes', q.quote_id, q);
    const { owner: _owner, ...publicQuote } = q;
    return { available: true, ...publicQuote, quote_signature: this.signer.sign(publicQuote) };
  }
  orderInput(input, owner, operation) {
    only(input, ['quote_id', 'client_order_id', 'registrant', 'accept_terms', 'terms_version']);
    if (!owner) fail('owner_auth_required', 401);
    if (!/^[a-zA-Z0-9_-]{16,80}$/.test(input.client_order_id || '') || !/^[a-zA-Z0-9_-]{32}$/.test(input.quote_id || '')) fail('invalid_order_id');
    const id = digest(`${owner}:${input.client_order_id}`), fingerprint = digest({ input, operation });
    const prior = this.store.get('orders', id);
    if (prior) { if (prior.fingerprint !== fingerprint) fail('idempotency_conflict', 409); return { order: prior }; }
    const quote = this.store.get('quotes', input.quote_id);
    if (!quote || quote.operation !== operation || Date.parse(quote.expires_at) <= this.now()) fail('quote_expired_or_unknown', 409);
    if (quote.owner && quote.owner !== owner) fail('quote_owner_mismatch', 403);
    if (input.accept_terms !== true || input.terms_version !== quote.terms_version) fail('terms_acceptance_required', 422);
    if (operation === 'register') registrant(input.registrant);
    else if (input.registrant !== undefined) fail('registrant_change_not_supported');
    const record = operation === 'renew' ? this.owned(quote.domain, owner) : null;
    if (record && record.expires_at !== quote.based_on_expiry) fail('renewal_quote_stale', 409);
    const order = { id, fingerprint, owner, quote, domain: quote.domain, operation, price_usd: quote.price_usd,
      registrant: input.registrant || null, prepared: record?.prepared || null,
      provider_domain_id: record?.provider_domain_id || null, before_expiry: record?.expires_at || null,
      state: 'awaiting_payment', created_at: this.now(), updated_at: this.now() };
    this.store.put('orders', id, order); return { order };
  }
  challenge(order) {
    return { x402Version: 2, resource: { url: `${this.origin}/${order.operation}`, description: `Register or renew ${order.domain} for one year. Owner contact and accepted terms are bound to this order.`, mimeType: 'application/json' },
      accepts: [this.payments.terms(order.price_usd)], order_id: order.id,
      domain_order_binding: { protocol: 'domain-payment-order/1', origin: this.origin, owner: order.owner } };
  }
  view(order) {
    return { order_id: order.id, domain: order.domain, operation: order.operation, status: order.state, mode: this.mode,
      price_usd: order.price_usd, updated_at: new Date(order.updated_at).toISOString(),
      ...(order.state === 'awaiting_payment' ? { payment_required: this.challenge(order) } : {}),
      ...(order.payment?.transaction ? { payment_transaction: order.payment.transaction } : {}),
      ...(order.refund?.transaction ? { refund_transaction: order.refund.transaction } : {}),
      ...(order.result ? { domain_info: order.result } : {}),
      ...(order.receipt ? { receipt: order.receipt, receipt_signature: order.receipt_signature } : {}),
      ...(order.reason ? { reason: order.reason } : {}) };
  }
  async order(input, owner, operation, paymentHeader) {
    if (this.refusesOrders) fail('demo_mode', 403);
    return this.serial(`domain:${input.quote_id && this.store.get('quotes', input.quote_id)?.domain}`, async () => {
      let { order } = this.orderInput(input, owner, operation);
      if (order.state !== 'awaiting_payment') return this.view(order);
      if (Date.parse(order.quote.expires_at) <= this.now()) fail('quote_expired', 409);
      if (operation === 'renew' && this.owned(order.domain, owner).expires_at !== order.before_expiry) fail('renewal_quote_stale', 409);
      if (this.mode !== 'demo' && this.provider.kind === 'demo') fail('demo_provider_disabled', 503);
      if (this.payments.kind !== 'demo' && !paymentHeader) return this.view(order);
      if (operation === 'register' && this.store.get('domains', order.domain)) fail('domain_already_managed', 409);
      // A fresh availability/price check BEFORE charging. Never charge a stale quote's higher price.
      const fresh = await this.provider.quote({ domain: order.domain, operation, period_years: 1 });
      if (fresh.available !== true || fresh.premium !== false || fresh.currency !== 'USD' || units(fresh.cost_usd) > units(order.quote.cost_usd)) fail('requote_required', 409);
      const terms = this.payments.terms(order.price_usd);
      const pay = this.payments.inspect(paymentHeader, terms, this.now(), order.id);
      if (this.payments.kind !== 'demo' && pay.payer === this.payments.refundAddress?.toLowerCase()) fail('refund_wallet_is_payer', 409);
      if (this.payments.kind !== 'demo') await this.payments.verifyOrder(pay.payload, this.origin, order.id, owner);
      await this.payments.verify(pay.payload, terms);
      const proof = await this.payments.prepareProof(pay.payload, terms);
      this.store.transaction(() => {
        order = this.store.get('orders', order.id);
        if (order.state !== 'awaiting_payment') fail('order_in_progress', 409);
        if (Date.parse(order.quote.expires_at) <= this.now()) fail('quote_expired', 409);
        const lock = this.store.get('domain-locks', order.domain);
        if (lock && lock.order_id !== order.id) fail('domain_order_in_progress', 409);
        const reference = digest(pay.reference);
        if (this.store.get('payments', reference)) fail('payment_already_bound', 409);
        this.store.put('payments', reference, { order_id: order.id });
        this.store.put('domain-locks', order.domain, { order_id: order.id });
        this.save(order, 'settlement_pending', { payment: { ...pay, proof, terms } });
      });
      try {
        const result = await this.payments.settle(pay.payload, terms);
        this.save(order, 'paid', { payment: { ...order.payment, transaction: result.transaction } });
      } catch { return this.view(order); }
      await this.fulfil(order);
      return this.view(this.store.get('orders', order.id));
    });
  }
  releaseLock(order) {
    const lock = this.store.get('domain-locks', order.domain);
    if (lock?.order_id === order.id) this.store.delete('domain-locks', order.domain);
  }
  async fulfil(order) {
    if (order.state !== 'paid') return;
    // Claimed durably before the first customer/provisioning call. Recovery never blindly resubmits.
    const claimed = this.store.transaction(() => {
      const fresh = this.store.get('orders', order.id); if (fresh.state !== 'paid') return false;
      this.save(order, 'preparing'); return true;
    });
    if (!claimed) return;
    try {
      const fresh = await this.provider.quote({ domain: order.domain, operation: order.operation, period_years: 1 });
      if (!fresh.available || fresh.premium !== false || fresh.currency !== 'USD' || units(fresh.cost_usd) > units(order.quote.cost_usd)) {
        this.save(order, 'refund_due', { reason: 'availability_or_price_changed' }); await this.refund(order); return;
      }
      if (!order.prepared) order.prepared = await this.provider.prepare({ registrant: order.registrant, order_id: order.id });
      if (!order.prepared || typeof order.prepared.customer_handle !== 'string') throw Error('invalid_customer');
    } catch {
      // No registration has been attempted in this stage; a contact creation is not a domain purchase.
      this.save(order, 'refund_due', { reason: 'registration_not_started' }); await this.refund(order); return;
    }
    this.save(order, 'registration_pending');
    try { await this.applyResult(order, await this.provider.submit(order)); }
    catch (error) {
      if (error.definite === true) { this.save(order, 'refund_due', { reason: 'registrar_definite_refusal' }); await this.refund(order); }
      // All other outcomes remain pending, even on timeout/restart. No automatic retry of submit.
    }
  }
  async applyResult(order, result) {
    if (result?.status === 'failed' && result.definite === true) {
      this.save(order, 'refund_due', { reason: 'registrar_definite_refusal' }); await this.refund(order); return;
    }
    if (result?.status !== 'delivered') return;
    const r = result.domain;
    if (!r || r.domain !== order.domain || !r.provider_domain_id || r.status !== 'active' || !Number.isFinite(Date.parse(r.expires_at))) return;
    if (order.operation === 'renew' && Date.parse(r.expires_at) <= Date.parse(order.before_expiry)) return;
    // Allow-list what leaves the registrar adapter: never forward auth codes/contact details in receipts.
    const clean = { domain: r.domain, provider_domain_id: String(r.provider_domain_id), status: 'active', expires_at: r.expires_at,
      nameservers: Array.isArray(r.nameservers) ? r.nameservers.filter(n => typeof n === 'string').slice(0, 13) : [],
      action_required: r.action_required === 'verify_registrant_email' ? r.action_required : null, autorenew: false };
    const receipt = { v: 1, kind: 'domain_delivery', capability: CAPS[order.operation], product_id: this.productId,
      order_id: order.id, domain: order.domain, operation: order.operation, period_years: 1, expires_at: clean.expires_at,
      owner_key_sha256: digest(order.owner), price_usd: order.price_usd, transaction: order.payment.transaction,
      issued_at: new Date(this.now()).toISOString(), mode: this.mode };
    this.store.transaction(() => {
      this.store.put('domains', order.domain, { ...clean, owner: order.owner, prepared: order.prepared, last_order_id: order.id });
      this.save(order, 'delivered', { result: clean, receipt, receipt_signature: this.signer.sign(receipt), registrant: null });
      this.releaseLock(order);
    });
  }
  async refund(order) {
    if (order.state !== 'refund_due') return;
    const amount = units(order.price_usd), day = new Date(this.now()).toISOString().slice(0, 10);
    const wallet = this.payments.refundAddress;
    if (!wallet || amount > units(this.payments.maxRefundUsd)) return;
    const budgetId = `${wallet}:${day}`;
    const claimed = this.store.transaction(() => {
      const latest = this.store.get('orders', order.id); if (latest.state !== 'refund_due') return false;
      const budget = this.store.get('refund-budget', budgetId) || { reserved: '0' };
      if (BigInt(budget.reserved) + amount > units(this.payments.dailyRefundUsd)) return false;
      this.store.put('refund-budget', budgetId, { reserved: (BigInt(budget.reserved) + amount).toString() });
      this.save(order, 'refund_preparing', { refund: { budget_id: budgetId } }); return true;
    });
    if (!claimed) return;
    try {
      const { payload, terms } = await this.payments.refundPayload(order, this.origin);
      await this.payments.verify(payload, terms);
      const proof = await this.payments.prepareProof(payload, terms);
      this.save(order, 'refund_pending', { refund: { ...order.refund, payload, terms, proof } });
      const result = await this.payments.settle(payload, terms);
      this.finishRefund(order, result.transaction);
    } catch {
      // A preparing refund has never reached settle. Once pending, only chain reconciliation
      // can decide the outcome; signing or settling a replacement would risk a double refund.
      if (order.state === 'refund_preparing') this.retryUnsubmittedRefund(order);
    }
  }
  retryUnsubmittedRefund(order) {
    this.store.transaction(() => {
      if (this.store.get('orders', order.id).state !== 'refund_preparing') return;
      const budget = this.store.get('refund-budget', order.refund.budget_id);
      this.store.put('refund-budget', order.refund.budget_id, { reserved: (BigInt(budget.reserved) - units(order.price_usd)).toString() });
      this.save(order, 'refund_due', { refund: null });
    });
  }
  finishRefund(order, transaction) {
    this.store.transaction(() => {
      this.save(order, 'refunded', { refund: { ...order.refund, transaction }, registrant: null }); this.releaseLock(order);
    });
  }
  async status(input, owner) {
    only(input, ['order_id']); const order = this.store.get('orders', input.order_id || '');
    if (!order || order.owner !== owner) fail('order_not_found', 404);
    return this.view(order);
  }
  async info(input, owner) {
    only(input, ['domain']); const record = this.owned(splitDomain(input.domain, this.provider.tlds).domain, owner);
    return this.provider.info(record);
  }
  async dnsGet(input, owner) {
    only(input, ['domain']); if (!this.provider.features.includes('dns')) fail('dns_not_supported', 422);
    return this.provider.dnsGet(this.owned(splitDomain(input.domain, this.provider.tlds).domain, owner));
  }
  async dnsSet(input, owner) {
    only(input, ['domain', 'records', 'revision']); if (!this.provider.features.includes('dns')) fail('dns_not_supported', 422);
    const record = this.owned(splitDomain(input.domain, this.provider.tlds).domain, owner);
    if (!/^[0-9a-f]{64}$/.test(input.revision || '')) fail('dns_revision_required');
    const records = validateRecords(record.domain, structuredClone(input.records));
    return this.serial(`dns:${record.domain}`, async () => {
      const current = await this.provider.dnsGet(record);
      for (const r of records) {
        if (current.records.some(old => old.name === r.name && ((old.type === 'CNAME' && r.type !== 'CNAME') || (r.type === 'CNAME' && old.type !== 'CNAME')))) fail('cname_conflict');
      }
      return this.provider.dnsSet(record, records, input.revision);
    });
  }
  async transferCode(input, owner) {
    only(input, ['domain']); if (!this.provider.features.includes('transfer_code')) fail('transfer_not_supported', 422);
    return this.provider.transferCode(this.owned(splitDomain(input.domain, this.provider.tlds).domain, owner));
  }
  async reconcileAll() {
    if (this.recovering) return; this.recovering = true;
    try {
      const pending = this.store.all('orders').filter(o => !TERMINAL.has(o.state) && !['awaiting_payment', 'refund_review'].includes(o.state));
      const start = this.recoveryCursor % (pending.length || 1);
      const orders = [...pending.slice(start), ...pending.slice(0, start)].slice(0, 100);
      this.recoveryCursor = start + orders.length;
      for (const candidate of orders) {
        // Never reconcile a live request while its submit/settle call is still running.
        if (this.running.has(`domain:${candidate.domain}`)) continue;
        await this.serial(`domain:${candidate.domain}`, async () => {
          const o = this.store.get('orders', candidate.id);
          try {
            if (o.state === 'settlement_pending') {
              const result = await this.payments.reconcile(o.payment.proof);
              if (result.status === 'paid') { this.save(o, 'paid', { payment: { ...o.payment, transaction: result.transaction } }); await this.fulfil(o); }
              else if (result.status === 'unpaid') { this.save(o, 'cancelled', { registrant: null, reason: 'payment_not_settled' }); this.releaseLock(o); }
              else if (result.nextBlock) this.save(o, o.state, { payment: { ...o.payment, proof: { ...o.payment.proof, nextBlock: result.nextBlock } } });
            } else if (o.state === 'paid') await this.fulfil(o);
            else if (o.state === 'preparing' && this.now() - o.updated_at > 120000) { this.save(o, 'refund_due', { reason: 'interrupted_before_registration' }); await this.refund(o); }
            else if (o.state === 'registration_pending') {
              const evidence = this.store.get('operator-evidence', o.id);
              if (evidence?.conclusion === 'registrar_confirmed_no_registration_or_renewal') await this.applyResult(o, { status: 'failed', definite: true });
              else await this.applyResult(o, await this.provider.reconcile(o));
            }
            else if (o.state === 'refund_due') await this.refund(o);
            else if (o.state === 'refund_preparing' && this.now() - o.updated_at > 120000) this.retryUnsubmittedRefund(o);
            else if (o.state === 'refund_pending') {
              const result = await this.payments.reconcile(o.refund.proof);
              if (result.status === 'paid') this.finishRefund(o, result.transaction);
              else if (result.status === 'unpaid') this.save(o, 'refund_review', { reason: 'refund_expired_unused' });
              else if (result.nextBlock) this.save(o, o.state, { refund: { ...o.refund, proof: { ...o.refund.proof, nextBlock: result.nextBlock } } });
            }
          } catch { /* A failed read proves nothing. Preserve durable state for the next pass. */ }
        });
      }
      // Public quotes are short lived; do not retain an unbounded discovery history.
      for (const q of this.store.all('quotes')) if (Date.parse(q.expires_at) < this.now() - 3600000) this.store.delete('quotes', q.quote_id);
    } finally { this.recovering = false; }
  }
}
