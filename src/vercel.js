import { canonical, domainName, fail } from './core.js';
import { validateRecords } from './dns.js';

// Runs on the BUYER side. The Vercel token never reaches the domain seller or the model.
// The project/team are pinned in configuration, not selected by a remote response.
export class VercelConnector {
  constructor({ client, token, project, team, fetchImpl = fetch }) {
    if (!token || !project) throw Error('Vercel token and pinned project required');
    Object.assign(this, { client, token, project, team, fetchImpl });
  }
  async api(method, path, body, query = {}) {
    const url = new URL(`https://api.vercel.com${path}`);
    for (const [k, v] of Object.entries({ ...query, ...(this.team ? { teamId: this.team } : {}) })) url.searchParams.set(k, v);
    const response = await this.fetchImpl(url, { method, redirect: 'error', signal: AbortSignal.timeout(20000),
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) throw Object.assign(Error('vercel_request_failed'), { code: 'vercel_request_failed', status: response.status });
    return response.json();
  }
  projectPath(domain) { return `/v9/projects/${encodeURIComponent(this.project)}/domains/${encodeURIComponent(domain)}`; }
  async projectDomain(domain) {
    try { return await this.api('GET', this.projectPath(domain)); }
    catch (error) { if (error.status === 404) return null; throw error; }
  }
  config(domain) { return this.api('GET', `/v6/domains/${encodeURIComponent(domain)}/config`, null, { projectIdOrName: this.project }); }
  async connect(input) {
    const { domain: raw, replace_existing = false } = input;
    if (Object.keys(input).some(k => !['domain', 'replace_existing'].includes(k)) || typeof replace_existing !== 'boolean') fail('invalid_fields');
    const domain = domainName(raw);
    const owned = await this.client.call('info', { domain });
    if (owned?.domain !== domain || owned.status !== 'active') fail('domain_not_active', 409);
    const old = await this.client.call('dnsGet', { domain });
    const config = await this.config(domain);
    const ranked = [...(config.recommendedIPv4 || [])].sort((a, b) => Number(a.rank) - Number(b.rank));
    const ips = ranked[0]?.value;
    if (!Array.isArray(ips) || !ips.length) fail('vercel_dns_recommendation_unavailable', 502);
    const records = validateRecords(domain, ips.map(value => ({ name: domain, type: 'A', value, ttl: 900 })));
    const conflicts = old.records.filter(r => r.name === domain && ['A', 'AAAA', 'CNAME'].includes(r.type)
      && !(r.type === 'A' && ips.includes(r.value)));
    // This v1 API cannot delete another RRtype. Never leave a conflicting AAAA/CNAME silently.
    if (conflicts.some(r => r.type !== 'A')) fail('remove_conflicting_ipv6_or_cname_first', 409);
    if (conflicts.length && !replace_existing) fail('existing_dns_requires_explicit_replacement', 409);
    let attached = await this.projectDomain(domain);
    if (!attached) {
      // Never move a domain from another project. An ambiguous response is resolved by the
      // next call's GET; no blind POST retry occurs in this invocation.
      attached = await this.api('POST', `/v10/projects/${encodeURIComponent(this.project)}/domains`, { name: domain });
    }
    if (attached.name !== domain || attached.redirect || attached.gitBranch || attached.customEnvironmentId) fail('vercel_domain_configuration_conflict', 409);
    for (const challenge of attached.verification || []) {
      if (challenge.type !== 'TXT' || typeof challenge.domain !== 'string' || typeof challenge.value !== 'string') fail('unsupported_vercel_verification', 422);
      const name = challenge.domain.replace(/\.$/, '').toLowerCase();
      // Preserve existing TXT values even when a verification challenge shares their name.
      for (const r of old.records.filter(r => r.name === name && r.type === 'TXT')) {
        if (!records.some(x => x.name === name && x.type === 'TXT' && x.value === r.value)) records.push(r);
      }
      if (!records.some(r => r.name === name && r.type === 'TXT' && r.value === challenge.value)) records.push({ name, type: 'TXT', value: challenge.value, ttl: 900 });
    }
    validateRecords(domain, records); // also rejects challenges outside the purchased zone
    const desired = r => ({ name: r.name, type: r.type, value: r.value, ttl: r.ttl, prio: r.prio || 0 });
    const keys = new Set(records.map(r => `${r.name}:${r.type}`));
    const existing = old.records.filter(r => keys.has(`${r.name}:${r.type}`)).map(desired).map(canonical).sort();
    const target = records.map(desired).map(canonical).sort();
    if (canonical(existing) !== canonical(target)) await this.client.call('dnsSet', { domain, revision: old.revision, records });
    if (attached.verified !== true) {
      try { attached = await this.api('POST', `${this.projectPath(domain)}/verify`); }
      catch (error) { if (error.status !== 400) throw error; } // DNS propagation may still be pending
    }
    const after = await this.config(domain);
    const ready = attached.verified === true && after.misconfigured === false;
    return { domain, project: this.project, status: ready ? 'configured' : 'waiting_for_verification_or_dns',
      verified: attached.verified === true, dns_configured: after.misconfigured === false,
      url: `https://${domain}`, records, note: 'Vercel configuration status is not an HTTPS reachability test. Retry this call after DNS propagation; it does not purchase or renew domains.' };
  }
}
