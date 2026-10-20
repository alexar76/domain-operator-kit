// Direct registration into the operator's own Porkbun account.
// This does not enable live selling or change the sandbox-only supplier adapter.
import { randomUUID } from 'node:crypto';
import { canonical, digest } from './core.js';

const BASE = 'https://api.porkbun.com/api/json/v3';
const WINDOW = 23 * 60 * 60 * 1000;
export class OwnerPilot {
  constructor({ apiKey, secretKey, domain, maxCents, store, fetchImpl = fetch, now = Date.now }) {
    if (!/^pk1_(?!sb_)[a-f0-9]+$/.test(apiKey) || !/^sk1_(?!sb_)[a-f0-9]+$/.test(secretKey)) throw Error('production_keys_required');
    if (!/^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]\.click$/.test(domain)) throw Error('pilot_requires_click_domain');
    if (!Number.isInteger(maxCents) || maxCents < 1 || maxCents > 300) throw Error('maximum_budget_300_cents');
    Object.assign(this, { apiKey, secretKey, domain, maxCents, store, fetchImpl, now });
    const binding = { account: digest(apiKey), domain, maxCents };
    const prior = store.get('owner-pilot', 'binding');
    if (prior && canonical(prior) !== canonical(binding)) throw Error('pilot_binding_changed');
    if (!prior) store.put('owner-pilot', 'binding', binding);
  }
  async api(method, path, body, key) {
    let response;
    try {
      response = await this.fetchImpl(`${BASE}${path}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(30000),
        headers: { 'content-type': 'application/json', 'X-API-Key': this.apiKey, 'X-Secret-API-Key': this.secretKey,
          ...(key ? { 'Idempotency-Key': key } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch { throw Error(key ? 'write_outcome_unknown_rerun_same_state' : 'porkbun_read_failed'); }
    let result;
    try { result = await response.json(); } catch { throw Error('unreadable_porkbun_response'); }
    if (result.sandbox === true) throw Error('unexpected_sandbox');
    if (!response.ok || result.status !== 'SUCCESS') {
      const code = /^[A-Z0-9_]{1,80}$/.test(result.code || '') ? result.code : 'REFUSED';
      throw Error(`porkbun_${response.status}_${code}`);
    }
    return result;
  }
  async write(id, path, body) {
    const fingerprint = digest({ path, body });
    let entry = this.store.get('owner-writes', id);
    if (entry && entry.fingerprint !== fingerprint) throw Error('write_body_changed');
    if (entry?.result) return entry.result;
    if (entry && (this.now() < entry.at || this.now() - entry.at >= WINDOW)) throw Error('replay_window_expired_manual_reconciliation_required');
    if (!entry) entry = this.store.put('owner-writes', id, { fingerprint, key: randomUUID(), at: this.now() });
    const result = await this.api('POST', path, body, entry.key);
    if (result.dryRun) throw Error('preview_is_not_delivery');
    this.store.put('owner-writes', id, { ...entry, result });
    return result;
  }
  async preflight() {
    const requirements = await this.api('GET', '/domain/getRegistrationRequirements/click');
    if (requirements.apiRegisterable !== true || requirements.registrationDurationYears !== 1 ||
        requirements.registryRequirements != null || requirements.whoisPrivacySupported !== true) throw Error('unsupported_registration_requirements');
    const quote = (await this.api('POST', `/domain/checkDomain/${this.domain}`, {})).response;
    if (quote?.avail !== 'yes' || quote.premium !== 'no' || quote.minDuration !== 1 || quote.type !== 'registration') throw Error('domain_not_eligible');
    if (!/^\d+\.\d{2}$/.test(quote.price)) throw Error('invalid_price');
    const cost = Number(quote.price.replace('.', ''));
    if (!Number.isSafeInteger(cost) || cost <= 0 || cost > this.maxCents) throw Error('budget_exceeded');
    const body = { cost, agreeToTerms: 'yes', whoisPrivacy: true };
    const preview = await this.api('POST', `/domain/create/${this.domain}`, { ...body, dryRun: true });
    if (preview.dryRun !== true || preview.wouldSucceed !== true || preview.domain !== this.domain ||
        preview.cost !== cost || preview.duration !== 1 || preview.premium !== false ||
        preview.sufficientFunds !== true) throw Error('registration_preflight_failed');
    return { body, cost, renewal: quote.additional?.renewal?.price, balance: preview.balance };
  }
  async register() {
    // Freeze the purchase body before any billable request. Never re-quote an
    // ambiguous registration: availability will have changed if it succeeded.
    let intent = this.store.get('owner-pilot', 'purchase');
    if (!intent) {
      intent = { ...(await this.preflight()), at: this.now() };
      this.store.put('owner-pilot', 'purchase', intent);
    }
    if (!Number.isInteger(intent.cost) || intent.cost > this.maxCents || intent.cost <= 0 ||
        intent.body.cost !== intent.cost) throw Error('invalid_saved_cost');
    const receipt = await this.write('registration', `/domain/create/${this.domain}`, intent.body);
    if (receipt.domain !== this.domain || receipt.cost !== intent.cost || !Number.isSafeInteger(receipt.orderId)) throw Error('invalid_purchase_receipt');
    await this.write('autorenew-off', `/domain/updateAutoRenew/${this.domain}`, { status: 'off' });
    const info = (await this.api('GET', `/domain/get/${this.domain}`)).domain;
    if (info?.domain !== this.domain || info.status !== 'ACTIVE' || Number(info.autoRenew) !== 0) throw Error('domain_not_ready_or_autorenew_enabled');
    return { domain: this.domain, cost: receipt.cost, orderId: receipt.orderId, balance: receipt.balance,
      renewal: intent.renewal, autoRenew: false, expires: info.expireDate };
  }
  async zone() {
    const ns = (await this.api('GET', `/domain/getNs/${this.domain}`)).ns;
    if (!Array.isArray(ns) || !ns.length || ns.some(n => !n.replace(/\.$/, '').endsWith('.ns.porkbun.com'))) throw Error('porkbun_nameservers_required');
    const rows = (await this.api('GET', `/dns/retrieve/${this.domain}`)).records;
    if (!Array.isArray(rows) || rows.some(r => !/^\d+$/.test(String(r.id)) || typeof r.name !== 'string')) throw Error('invalid_dns_response');
    return rows;
  }
  async configureDNS(desired) {
    if (!this.store.get('owner-writes', 'registration')?.result) throw Error('purchase_receipt_required');
    if (!Array.isArray(desired) || desired.length === 0 || desired.some(r =>
      !['A', 'TXT'].includes(r.type) || typeof r.content !== 'string' ||
      (r.name !== '' && !/^_vercel(?:\.[a-z0-9-]+)*$/.test(r.name)))) throw Error('invalid_dns_target');
    const target = digest(desired);
    let plan = this.store.get('owner-pilot', 'dns');
    if (plan && plan.target !== target) throw Error('dns_target_changed');
    if (!plan) {
      const before = await this.zone();
      const ops = [];
      const fqdn = r => r.name ? `${r.name}.${this.domain}` : this.domain;
      for (const r of before) {
        if (r.name === this.domain && ['A', 'AAAA', 'CNAME', 'ALIAS'].includes(r.type) &&
            !desired.some(d => d.type === r.type && fqdn(d) === r.name && d.content === r.content)) {
          ops.push({ path: `/dns/delete/${this.domain}/${r.id}`, body: {} });
        }
      }
      for (const d of desired) {
        if (!before.some(r => r.type === d.type && r.name === fqdn(d) && r.content === d.content)) {
          ops.push({ path: `/dns/create/${this.domain}`, body: { ...d, ttl: '600' } });
        }
      }
      plan = this.store.put('owner-pilot', 'dns', { target, before, ops });
    }
    for (const [i, op] of plan.ops.entries()) {
      const result = await this.write(`dns-${i}`, op.path, op.body);
      if (result.warnings?.length) throw Error('dns_provider_warning');
    }
    const after = await this.zone();
    for (const d of desired) {
      const name = d.name ? `${d.name}.${this.domain}` : this.domain;
      if (!after.some(r => r.name === name && r.type === d.type && r.content === d.content)) throw Error('dns_readback_mismatch');
    }
    if (after.some(r => r.name === this.domain && (['AAAA', 'CNAME', 'ALIAS'].includes(r.type) ||
        (r.type === 'A' && !desired.some(d => d.name === '' && d.type === 'A' && d.content === r.content))))) throw Error('conflicting_apex_dns');
    return { records: desired, plannedWrites: plan.ops.length };
  }
}
