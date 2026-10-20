import { createHmac } from 'node:crypto';
import { DomainError, fail, splitDomain, secureUrl, units, dollars, digest, canonical } from './core.js';

export class SupplierError extends DomainError {
  constructor(code, { definite = false } = {}) { super(code, 502); this.definite = definite; }
}

async function jsonFetch(fetchImpl, url, options, mutation = false) {
  // Only reads (including availability POSTs) can be retried. Never replay a
  // mutation after a timeout, malformed response or upstream server error.
  const attempts = mutation ? 1 : 2;
  for (let attempt = 0; attempt < attempts; attempt++) {
    let transient = true;
    try {
      const response = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(20000) });
      transient = response.ok || [429, 500, 502, 503, 504].includes(response.status);
      const text = await response.text();
      if (text.length > 2000000) throw Error('response too large');
      let data; try { data = JSON.parse(text); } catch { throw Error('invalid JSON'); }
      // A 5xx, timeout or malformed reply after a mutation NEVER proves no registration happened.
      if (!response.ok) throw new SupplierError('supplier_unavailable', { definite: mutation && [400, 401, 403, 422].includes(response.status) && data?.definite_failure === true });
      return data;
    } catch (e) {
      if (transient && attempt + 1 < attempts) { await new Promise(resolve => setTimeout(resolve, 250)); continue; }
      if (e instanceof SupplierError) throw e;
      throw new SupplierError(mutation ? 'supplier_outcome_unknown' : 'supplier_read_failed');
    }
  }
}

// Openprovider's published v1 REST contract. No guessed idempotency header: mutations are sent
// once, and registration recovery matches BOTH our order comment and customer handle.
export function openprovider({ username, password, sandbox = true, tlds = ['com', 'net', 'org'], fetchImpl = fetch,
  baseUrl = sandbox ? 'https://api.sandbox.openprovider.nl/v1beta' : 'https://api.openprovider.eu/v1', nsGroup = 'dns-openprovider', store }) {
  const base = secureUrl(baseUrl); let bearer = null, loginAt = 0;
  async function call(method, path, body, mutation = false) {
    if (!bearer || Date.now() - loginAt > 600000) {
      const login = await jsonFetch(fetchImpl, `${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
      if (login.code !== 0 || typeof login.data?.token !== 'string') throw new SupplierError('registrar_auth_failed');
      bearer = login.data.token; loginAt = Date.now();
    }
    const result = await jsonFetch(fetchImpl, `${base}${path}`, { method, headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }, mutation);
    // Unknown registrar error codes remain ambiguous for mutations; recovery decides, not text matching.
    if (result.code !== 0 || !result.data || result.maintenance) throw new SupplierError('registrar_refused');
    return result.data;
  }
  const shape = domain => { const { name, extension } = splitDomain(domain, tlds); return { name, extension }; };
  const cost = p => {
    const price = p?.price?.reseller;
    if (price?.currency !== 'USD') throw new SupplierError('supplier_currency_not_usd');
    return dollars(units(String(price.price)));
  };
  async function price(domain, operation) {
    const d = shape(domain);
    return call('GET', `/domains/prices?${new URLSearchParams({ 'domain.name': d.name, 'domain.extension': d.extension, operation, period: '1' })}`);
  }
  async function find(domain) {
    const data = await call('GET', `/domains?${new URLSearchParams({ full_name: domain, limit: '10', with_verification_email: 'true' })}`);
    return (data.results || []).find(r => `${r.domain?.name}.${r.domain?.extension}` === domain && !r.is_deleted) || null;
  }
  // Openprovider serializes simple TXT values with quotes on reads. Normalize
  // only unambiguous single strings; retain escaped/multi-string wire syntax.
  const txtValue = value => /^"[^"\\]*"$/.test(value) ? value.slice(1, -1) : value;
  const normalizedRecord = r => ({ ...r, value: r.type === 'TXT' ? txtValue(r.value) : r.value });
  function publicDomain(row) {
    return { provider_domain_id: String(row.id), domain: `${row.domain.name}.${row.domain.extension}`, expires_at: row.expiration_date,
      status: row.status === 'ACT' ? 'active' : 'pending',
      action_required: row.verification_email_status && row.verification_email_status !== 'verified' ? 'verify_registrant_email' : null,
      nameservers: (row.name_servers || []).map(n => n.name), autorenew: false };
  }
  return {
    kind: 'openprovider', sandbox, tlds, features: ['register', 'renew', 'info', 'dns', 'transfer_code'],
    async quote({ domain, operation }) {
      const d = shape(domain);
      if (operation === 'register') {
        const data = await call('POST', '/domains/check', { domains: [d], with_price: true });
        const result = data.results?.find(r => r.domain === domain);
        if (!result) throw new SupplierError('invalid_availability');
        if (result.status !== 'free') return { available: false };
        if (result.claim_key) fail('domain_claim_not_supported', 422);
        if (result.is_premium === true) fail('premium_not_supported', 422);
        // /domains/check omits is_premium for ordinary domains (documented and
        // observed in sandbox). /domains/prices below must explicitly confirm
        // non-premium for BOTH creation and renewal before we issue a quote.
        if (result.is_premium !== undefined && result.is_premium !== false) throw new SupplierError('registrar_premium_status_unknown');
        if (result.is_premium === undefined && result.premium != null) throw new SupplierError('registrar_premium_status_unknown');
      }
      const [p, renewal] = await Promise.all([price(domain, operation === 'register' ? 'create' : 'renew'), price(domain, 'renew')]);
      if (p.is_premium === true || renewal.is_premium === true) fail('premium_not_supported', 422);
      if (p.is_premium !== false || renewal.is_premium !== false) throw new SupplierError('registrar_premium_status_unknown');
      return { available: true, cost_usd: cost(p), renewal_cost_usd: cost(renewal), currency: 'USD', premium: false, period_years: 1 };
    },
    async prepare({ registrant: r, order_id }) {
      const c = await call('POST', '/customers', { name: { first_name: r.first_name, last_name: r.last_name }, email: r.email,
        company_name: r.company || '', phone: { country_code: r.phone_country, area_code: r.phone_area || '', subscriber_number: r.phone_number },
        address: { street: r.street, number: r.number, city: r.city, state: r.state || '', zipcode: r.postal_code, country: r.country },
        comments: `domain-kit:${order_id}` }, true);
      if (!c.handle) throw new SupplierError('customer_outcome_unknown');
      return { customer_handle: c.handle };
    },
    async submit(order) {
      if (order.operation === 'renew') {
        const result = await call('POST', `/domains/${encodeURIComponent(order.provider_domain_id)}/renew`, { period: 1 }, true);
        if (result.status === 'ACT' && store) store.put('registrar-acks', order.id, { accepted: true });
      } else {
        await call('POST', '/domains', { domain: shape(order.domain), period: 1, unit: 'y', autorenew: 'off',
          owner_handle: order.prepared.customer_handle, admin_handle: order.prepared.customer_handle,
          tech_handle: order.prepared.customer_handle, billing_handle: order.prepared.customer_handle,
          ns_group: nsGroup, comments: `domain-kit:${order.id}`, accept_premium_fee: 0, accept_eap_fee: 0,
          is_private_whois_enabled: false, is_spamexperts_enabled: false, is_sectigo_dns_enabled: false, is_easy_dmarc_enabled: false }, true);
      }
      return this.reconcile(order);
    },
    async reconcile(order) {
      const row = await find(order.domain);
      if (!row) return { status: 'pending' };
      if (order.operation === 'register') {
        if (row.comments !== `domain-kit:${order.id}` || row.owner_handle !== order.prepared?.customer_handle) return { status: 'pending' };
      } else {
        if (String(row.id) !== order.provider_domain_id || row.owner_handle !== order.prepared?.customer_handle) return { status: 'pending' };
        // An increased expiry alone is insufficient: external auto-renewal could have changed it.
        // Openprovider has no caller idempotency key for renewal, so an ambiguous renewal needs
        // operator evidence rather than claiming somebody else's renewal as this delivery.
        if (!store?.get('registrar-acks', order.id)?.accepted || Date.parse(row.expiration_date) <= Date.parse(order.before_expiry)) {
          return { status: 'pending', reason: 'renewal_requires_reconciliation' };
        }
      }
      if (row.status !== 'ACT') return { status: 'pending' };
      return { status: 'delivered', domain: publicDomain(row) };
    },
    async info(record) {
      const row = await call('GET', `/domains/${encodeURIComponent(record.provider_domain_id)}?with_verification_email=true`);
      if (`${row.domain?.name}.${row.domain?.extension}` !== record.domain || row.owner_handle !== record.prepared.customer_handle) fail('registrar_ownership_changed', 409);
      return publicDomain(row);
    },
    async dnsGet(record) {
      await this.info(record);
      const zone = await call('GET', `/dns/zones/${encodeURIComponent(record.domain)}?with_records=true`);
      const fullName = name => {
        const n = (name || '').replace(/\.$/, '').toLowerCase();
        return !n || n === '@' ? record.domain : n === record.domain || n.endsWith(`.${record.domain}`) ? n : `${n}.${record.domain}`;
      };
      const records = (zone.records || []).map(r => normalizedRecord({ name: fullName(r.name), type: r.type, value: r.value, ttl: Number(r.ttl), prio: Number(r.prio || 0) }));
      return { records, revision: digest(canonical(records)) };
    },
    async dnsSet(record, records, revision) {
      if (records.some(r => ![900, 3600, 10800, 21600, 43200, 86400].includes(r.ttl))) fail('registrar_ttl_requires_900_3600_10800_21600_43200_86400', 422);
      const old = await this.dnsGet(record);
      if (old.revision !== revision) fail('dns_revision_changed', 409);
      // Keep unchanged records out of the write entirely. Openprovider may
      // reject removing and adding the same value in a single request.
      const target = records.map(normalizedRecord);
      if (new Set(target.map(r => canonical([r.name, r.type, r.value]))).size !== target.length) fail('duplicate_dns_record');
      const keys = new Set(target.map(r => `${r.name}:${r.type}`));
      const current = old.records.filter(r => keys.has(`${r.name}:${r.type}`));
      const same = (a, b) => canonical(a) === canonical(b);
      const remove = current.filter(r => !target.some(t => same(r, t)));
      const add = target.filter(r => !current.some(t => same(r, t)));
      if (!remove.length && !add.length) return old;
      const relative = r => ({ ...r, name: r.name === record.domain ? '' : r.name.slice(0, -record.domain.length - 1),
        value: r.type === 'TXT' && !/["\\]/.test(r.value) ? JSON.stringify(r.value) : r.value });
      const update = [], additions = [];
      for (const next of add) {
        const i = remove.findIndex(r => r.name === next.name && r.type === next.type);
        if (i < 0) additions.push(relative(next));
        else update.push({ original_record: relative(remove.splice(i, 1)[0]), record: relative(next) });
      }
      await call('PUT', `/dns/zones/${encodeURIComponent(record.domain)}`, {
        records: { remove: remove.map(relative), add: additions, update },
      }, true);
      return this.dnsGet(record);
    },
    async transferCode(record) {
      await this.info(record);
      const row = await call('GET', `/domains/${encodeURIComponent(record.provider_domain_id)}`);
      if (!row.auth_code) fail('transfer_code_unavailable', 409);
      return { auth_code: row.auth_code, locked: Boolean(row.is_locked), note: 'Registrar transfer locks and registry rules still apply.' };
    },
  };
}

// An independent seller can implement this small HTTP contract in any language.
export function httpProvider({ url, secret, tlds, sandbox = false, features = ['register', 'renew', 'info'], fetchImpl = fetch, allowLocal = false }) {
  const base = secureUrl(url, allowLocal);
  if (!secret || secret.length < 32) throw Error('supplier secret needs 32+ characters');
  const call = async (path, input, mutation = false) => {
    const timestamp = String(Date.now()), body = canonical(input);
    const signature = createHmac('sha256', secret).update(`${timestamp}.POST.${path}.${body}`).digest('hex');
    const data = await jsonFetch(fetchImpl, `${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-kit-time': timestamp, 'x-kit-signature': signature }, body }, mutation);
    if (data.error) throw new SupplierError('supplier_refused', { definite: data.definite_failure === true });
    return data;
  };
  const supplierOrder = o => ({ id: o.id, domain: o.domain, operation: o.operation, period_years: 1,
    prepared: o.prepared, provider_domain_id: o.provider_domain_id, before_expiry: o.before_expiry,
    max_cost_usd: o.quote.cost_usd });
  const supplierDomain = r => ({ domain: r.domain, provider_domain_id: r.provider_domain_id, prepared: r.prepared });
  return { kind: 'http', sandbox, tlds, features,
    quote: input => call('/quote', input), prepare: input => call('/prepare', input, true),
    submit: input => call('/submit', supplierOrder(input), true), reconcile: input => call('/reconcile', supplierOrder(input)),
    info: input => call('/info', supplierDomain(input)), dnsGet: input => call('/dns/get', supplierDomain(input)),
    dnsSet: (domain, records, revision) => call('/dns/set', { domain: supplierDomain(domain), records, revision }, true),
    transferCode: input => call('/transfer-code', supplierDomain(input)),
  };
}

// The registries' own RDAP: a registered name answers 200, an unregistered one 404. Public, no keys,
// so a demo seller can answer real availability while its prices stay illustrative.
const RDAP = { com: 'https://rdap.verisign.com/com/v1/domain/', net: 'https://rdap.verisign.com/net/v1/domain/',
  org: 'https://rdap.publicinterestregistry.org/rdap/domain/' };
export function rdapAvailability({ fetchImpl = fetch } = {}) {
  return async domain => {
    const base = RDAP[domain.slice(domain.lastIndexOf('.') + 1)];
    if (!base) throw new SupplierError('availability_unknown');
    let response;
    try { response = await fetchImpl(base + domain, { headers: { accept: 'application/rdap+json' }, signal: AbortSignal.timeout(10000) }); }
    catch { throw new SupplierError('availability_unknown'); }
    if (response.status === 404) return true;
    if (response.ok) return false;
    throw new SupplierError('availability_unknown');
  };
}

export function demoProvider(store, { availability = null } = {}) {
  return { kind: 'demo', sandbox: true, tlds: ['com', 'net', 'org'], features: ['register', 'renew', 'info', 'dns'],
    availability: availability ? 'rdap' : 'simulated',
    async quote({ domain, operation }) {
      const free = operation === 'renew' || (!store.get('demo-domains', domain) && (!availability || await availability(domain)));
      return { available: free, currency: 'USD', cost_usd: '10.00', renewal_cost_usd: '12.00', premium: false, period_years: 1 };
    },
    async prepare({ order_id }) { return { customer_handle: `demo-${order_id}` }; },
    async submit(order) {
      const prior = store.get('demo-orders', order.id); if (prior) return prior;
      const old = store.get('demo-domains', order.domain);
      if (order.operation === 'register' && old) throw new SupplierError('domain_taken', { definite: true });
      const date = new Date(old?.expires_at || Date.now()); date.setUTCFullYear(date.getUTCFullYear() + 1);
      const domain = { domain: order.domain, provider_domain_id: order.domain, expires_at: date.toISOString(), status: 'active', action_required: null, nameservers: ['ns1.example.invalid'], autorenew: false };
      const result = { status: 'delivered', domain }; store.put('demo-domains', order.domain, domain); store.put('demo-orders', order.id, result); return result;
    },
    async reconcile(order) { return store.get('demo-orders', order.id) || { status: 'pending' }; },
    async info(record) { return store.get('demo-domains', record.domain); },
    async dnsGet(record) { const records = store.get('demo-dns', record.domain) || []; return { records, revision: digest(records) }; },
    async dnsSet(record, records, revision) {
      const old = await this.dnsGet(record); if (old.revision !== revision) fail('dns_revision_changed', 409);
      const keys = new Set(records.map(r => `${r.name}:${r.type}`));
      store.put('demo-dns', record.domain, [...old.records.filter(r => !keys.has(`${r.name}:${r.type}`)), ...records]); return this.dnsGet(record);
    },
  };
}
