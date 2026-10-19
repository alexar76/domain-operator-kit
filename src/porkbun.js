import { randomUUID } from 'node:crypto';
import { SupplierError } from './providers.js';
import { canonical, digest, dollars, units, splitDomain, fail } from './core.js';

const BASE = 'https://api.porkbun.com/api/json/v3';
// Porkbun guarantees replay for 24h. Leave an hour for clock skew/transport delay.
const REPLAY_WINDOW = 23 * 60 * 60 * 1000;
const cents = value => {
  const amount = units(String(value));
  if (amount <= 0n || amount % 10000n || amount > 100000000n) throw new SupplierError('porkbun_invalid_cost');
  return Number(amount / 10000n);
};
const contactFor = r => ({ firstName: r.first_name, lastName: r.last_name, organization: r.company || '',
  email: r.email, phoneCountryCode: r.phone_country.replace(/^\+/, ''), phone: `${r.phone_area || ''}${r.phone_number}`,
  address1: `${r.number} ${r.street}`, address2: '', address3: '', city: r.city, state: r.state || '', postalCode: r.postal_code, country: r.country });
const contactMatches = (actual, expected) => !!actual && !!expected &&
  ['firstName', 'lastName', 'organization', 'email', 'phoneCountryCode', 'phone', 'address1', 'city', 'postalCode', 'country']
    .every(k => String(actual[k] || '').trim().toLowerCase() === String(expected[k] || '').trim().toLowerCase());
const sortRecords = records => records.sort((a, b) => canonical(a).localeCompare(canonical(b)));

// Sandbox-only until a production pilot validates account eligibility, contact
// reassignment, verification emails and the 30-day renewal restriction.
export function porkbun({ apiKey, secretKey, sandbox = true, tlds = ['com', 'net', 'org'], store, fetchImpl = fetch, now = Date.now }) {
  if (!sandbox) throw Error('Porkbun live mode is not validated; use sandbox');
  if (!/^pk1_sb_[a-f0-9]+$/.test(apiKey || '') || !/^sk1_sb_[a-f0-9]+$/.test(secretKey || '')) throw Error('Porkbun requires a sandbox API key and secret key');
  if (!store) throw Error('Porkbun requires a durable Store');
  if (tlds.some(t => !['com', 'net', 'org'].includes(t))) throw Error('Porkbun supports com/net/org only');
  const identity = digest(apiKey), prior = store.get('meta', 'porkbun-account');
  if (prior && prior.identity !== identity) throw Error('Porkbun account changed; use a separate data directory');
  if (!prior) store.put('meta', 'porkbun-account', { identity });
  const domainPath = domain => { splitDomain(domain, tlds); return encodeURIComponent(domain); };
  let verified = false;
  async function requestOnce(method, path, body, idempotencyKey) {
    try {
      const response = await fetchImpl(`${BASE}${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(20000),
        headers: { 'content-type': 'application/json', 'X-API-Key': apiKey, 'X-Secret-API-Key': secretKey,
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      if ([429, 500, 502, 503, 504].includes(response.status)) throw new SupplierError(idempotencyKey ? 'supplier_outcome_unknown' : 'supplier_read_failed');
      const text = await response.text(); if (text.length > 2000000) throw Error('oversized response');
      const result = JSON.parse(text);
      if (result.sandbox !== true) throw new SupplierError('porkbun_sandbox_not_confirmed');
      if (!response.ok || result.status !== 'SUCCESS') {
        // No inference of definitive non-delivery from free-form error text.
        const code = /^[A-Z0-9_]{1,80}$/.test(result.code || '') ? result.code.toLowerCase() : 'refused';
        throw new SupplierError(`porkbun_${code}`);
      }
      if (result.dryRun) throw new SupplierError('porkbun_preview_is_not_delivery');
      return result;
    } catch (error) {
      if (error instanceof SupplierError) throw error;
      throw new SupplierError(idempotencyKey ? 'supplier_outcome_unknown' : 'supplier_read_failed');
    }
  }
  async function request(method, path, body, key) {
    try { return await requestOnce(method, path, body, key); }
    catch (error) {
      if (key || error.code !== 'supplier_read_failed') throw error;
      await new Promise(resolve => setTimeout(resolve, 500));
      return requestOnce(method, path, body, key);
    }
  }
  async function call(method, path, body, key) {
    if (!verified) { await request('POST', '/ping', {}); verified = true; }
    return request(method, path, body, key);
  }
  async function write(id, path, body) {
    const fingerprint = digest({ path, body });
    let entry = store.get('porkbun-writes', id);
    if (entry && entry.fingerprint !== fingerprint) throw new SupplierError('porkbun_request_changed');
    if (entry?.result) return entry.result;
    if (entry && (now() - entry.at >= REPLAY_WINDOW || now() < entry.at)) throw new SupplierError('porkbun_replay_window_expired');
    // Authenticate before creating the durable intent; persist before any write.
    if (!verified) { await request('POST', '/ping', {}); verified = true; }
    if (!entry) entry = store.put('porkbun-writes', id, { fingerprint, at: now(), key: randomUUID() });
    const result = await call('POST', path, body, entry.key);
    store.put('porkbun-writes', id, { ...entry, result });
    return result;
  }
  async function metadata(domain) {
    const result = await call('GET', `/domain/get/${domainPath(domain)}`), row = result.domain;
    if (row?.domain !== domain || !Number.isFinite(Date.parse(row.expireDate))) throw new SupplierError('porkbun_invalid_domain');
    return row;
  }
  async function contacts(domain) { return (await call('GET', `/domain/getContacts/${domainPath(domain)}`)).contacts; }
  async function describe(domain, row) {
    const ns = (await call('GET', `/domain/getNs/${domainPath(domain)}`)).ns;
    if (!Array.isArray(ns) || ns.some(n => typeof n !== 'string')) throw new SupplierError('porkbun_invalid_nameservers');
    return { provider_domain_id: domain, domain, expires_at: row.expireDate, status: row.status === 'ACTIVE' ? 'active' : 'pending',
      // Metadata does not prove the real registrant has verified their email.
      action_required: 'verify_registrant_email', nameservers: ns, autorenew: row.autoRenew !== 0 };
  }
  async function purchase(order) {
    const renewing = order.operation === 'renew';
    const result = await write(`purchase:${order.id}`, `/domain/${renewing ? 'renew' : 'create'}/${domainPath(order.domain)}`,
      { cost: cents(order.quote.cost_usd), ...(!renewing ? { agreeToTerms: 'yes', whoisPrivacy: true } : {}) });
    if (result.domain !== order.domain || !Number.isSafeInteger(result.orderId) || result.cost !== cents(order.quote.cost_usd)) {
      throw new SupplierError('porkbun_invalid_purchase_receipt');
    }
    return result;
  }
  async function zone(record) {
    const result = await call('GET', `/dns/retrieve/${domainPath(record.domain)}`);
    if (!Array.isArray(result.records)) throw new SupplierError('porkbun_invalid_dns');
    return result.records.map(r => {
      const name = String(r.name).replace(/\.$/, '').toLowerCase();
      if (!r.id || !(name === record.domain || name.endsWith(`.${record.domain}`)) || !Number.isInteger(Number(r.ttl))) throw new SupplierError('porkbun_invalid_dns');
      return { id: String(r.id), name, type: r.type, value: r.content, ttl: Number(r.ttl), prio: Number(r.prio || 0) };
    });
  }
  const publicZone = rows => {
    const records = sortRecords(rows.map(({ id, ...r }) => r));
    return { records, revision: digest(canonical(records)) };
  };
  const dnsBody = (domain, r) => ({ name: r.name === domain ? '' : r.name.slice(0, -domain.length - 1), type: r.type, content: r.value, ttl: r.ttl, prio: r.prio });
  return {
    kind: 'porkbun', sandbox: true, tlds, features: ['register', 'renew', 'info', 'dns'],
    async quote({ domain, operation }) {
      const { extension } = splitDomain(domain, tlds);
      const requirements = await call('GET', `/domain/getRegistrationRequirements/${extension}`);
      if (requirements.apiRegisterable !== true || requirements.registrationDurationYears !== 1 || requirements.registryRequirements != null) fail('unsupported_registration_requirements', 422);
      const p = (await call('POST', `/domain/checkDomain/${domainPath(domain)}`, {})).response;
      if (!p || !['yes', 'no'].includes(p.avail)) throw new SupplierError('invalid_availability');
      if (p.premium === 'yes') fail('premium_not_supported', 422);
      if (p.premium !== 'no') throw new SupplierError('registrar_premium_status_unknown');
      if (p.minDuration !== 1) fail('unsupported_registration_period', 422);
      if (operation === 'register' && p.avail !== 'yes') return { available: false };
      const renewal = p.additional?.renewal;
      if (renewal?.type !== 'renewal' || p.type !== 'registration') throw new SupplierError('porkbun_invalid_prices');
      cents(p.price); cents(renewal.price);
      return { available: true, cost_usd: dollars(units(operation === 'renew' ? renewal.price : p.price)),
        renewal_cost_usd: dollars(units(renewal.price)), currency: 'USD', premium: false, period_years: 1 };
    },
    async prepare({ registrant }) {
      const contact = contactFor(registrant);
      return { customer_handle: digest(contact), contact };
    },
    async submit(order) { return this.reconcile(order); },
    async reconcile(order) {
      // This may repeat the original write, but ONLY with its persisted key/body
      // inside the registrar's guaranteed replay window. Expiry alone is not proof.
      await purchase(order);
      let row = await metadata(order.domain);
      if (row.status !== 'ACTIVE') return { status: 'pending' };
      if (order.operation === 'register') {
        // Creation uses account defaults. Do not publish delivery until reassignment
        // and auto-renew are independently read back. Never change account defaults.
        await write(`autorenew:${order.id}`, `/domain/updateAutoRenew/${domainPath(order.domain)}`, { status: 'off' });
        await write(`contacts:${order.id}`, `/domain/updateContacts/${domainPath(order.domain)}`, { contact: order.prepared.contact });
        row = await metadata(order.domain);
      }
      const actual = await contacts(order.domain);
      if (!contactMatches(actual?.registrant, order.prepared?.contact) || row.autoRenew !== 0) return { status: 'pending' };
      if (order.operation === 'renew' && Date.parse(row.expireDate) <= Date.parse(order.before_expiry)) return { status: 'pending' };
      return { status: 'delivered', domain: await describe(order.domain, row) };
    },
    async info(record) {
      const row = await metadata(record.domain), actual = await contacts(record.domain);
      if (record.provider_domain_id !== record.domain || !contactMatches(actual?.registrant, record.prepared?.contact)) fail('registrar_ownership_changed', 409);
      if (row.autoRenew !== 0) fail('registrar_autorenew_changed', 409);
      return describe(record.domain, row);
    },
    async dnsGet(record) { await this.info(record); return publicZone(await zone(record)); },
    async dnsSet(record, records, revision) {
      await this.info(record);
      if (records.some(r => r.ttl < 600)) fail('porkbun_ttl_minimum_600', 422);
      if (new Set(records.map(r => canonical([r.name, r.type, r.value]))).size !== records.length) fail('duplicate_dns_record');
      const target = sortRecords(records.map(r => ({ ...r }))), intent = digest({ revision, target });
      let plan = store.get('porkbun-dns-pending', record.domain);
      if (plan && plan.intent !== intent) fail('porkbun_dns_reconciliation_required', 409);
      if (!plan) {
        const rows = await zone(record), before = publicZone(rows);
        if (before.revision !== revision) fail('dns_revision_changed', 409);
        const keys = new Set(target.map(r => `${r.name}:${r.type}`));
        const old = rows.filter(r => keys.has(`${r.name}:${r.type}`));
        const same = (a, b) => canonical(a) === canonical(b);
        const remove = old.filter(({ id, ...r }) => !target.some(t => same(r, t)));
        const add = target.filter(t => !old.some(({ id, ...r }) => same(r, t)));
        const steps = [];
        for (const next of add) {
          const i = remove.findIndex(r => r.name === next.name && r.type === next.type);
          const existing = i < 0 ? null : remove.splice(i, 1)[0];
          steps.push({ path: `/dns/${existing ? `edit/${record.domain}/${existing.id}` : `create/${record.domain}`}`, body: dnsBody(record.domain, next) });
        }
        for (const r of remove) steps.push({ path: `/dns/delete/${record.domain}/${r.id}`, body: {} });
        if (!steps.length) return before;
        plan = store.put('porkbun-dns-pending', record.domain, { intent, id: randomUUID(), steps, next: 0, warnings: [], expected: before.revision });
      }
      for (; plan.next < plan.steps.length; plan.next++) {
        const step = plan.steps[plan.next], id = `dns:${plan.id}:${plan.next}`;
        // An interrupted step must replay before comparing the resulting revision.
        if (!store.get('porkbun-writes', id) && publicZone(await zone(record)).revision !== plan.expected) fail('dns_revision_changed', 409);
        const result = await write(id, step.path, step.body);
        plan.warnings.push(...(result.warnings || []).filter(w => typeof w === 'string'));
        plan.expected = publicZone(await zone(record)).revision;
        store.put('porkbun-dns-pending', record.domain, { ...plan, next: plan.next + 1 });
      }
      const after = publicZone(await zone(record));
      store.delete('porkbun-dns-pending', record.domain);
      return { ...after, ...(plan.warnings.length ? { warnings: [...new Set(plan.warnings)] } : {}) };
    },
  };
}
