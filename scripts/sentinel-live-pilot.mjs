#!/usr/bin/env node
// Single, explicitly authorized owner-account pilot. No GitHub operations.
import { readFileSync, writeFileSync, mkdirSync, existsSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { isIP } from 'node:net';
import { Store } from '../src/store.js';
import { OwnerPilot } from '../src/owner-pilot.js';
import { waitForSetup } from '../src/setup-readiness.js';

const DOMAIN = 'sentinelproof.click';
const PROJECT = 'prj_R60mXF9IRqTPgMjXzHOflNHyUzI0';
const NAME = 'prod-bdb1634806de';
const TEAM = 'team_daP1l78JuLzuhEHDalNHSlKM';
const ORIGINAL = 'dpl_C1hg5WytZohHYftaDYS1u8z4etCA';
const dir = resolve(import.meta.dirname, '../data/sentinel-live');
mkdirSync(dir, { recursive: true, mode: 0o700 });
const keyPath = join(dir, 'state.key');
if (!existsSync(keyPath)) writeFileSync(keyPath, randomBytes(32), { flag: 'wx', mode: 0o600 });
const lockPath = join(dir, 'pilot.lock');
const lock = openSync(lockPath, 'wx', 0o600);
writeFileSync(lock, String(process.pid));
const store = new Store(join(dir, 'state.sqlite'), readFileSync(keyPath));

// Use the existing token exclusively on its server. Only API results return.
async function vercel(method, path, body) {
  const request = Buffer.from(JSON.stringify({ method, path, body })).toString('base64');
  const python = `
import base64,json,urllib.request,urllib.error
from pathlib import Path
q=json.loads(base64.b64decode('${request}'))
token=Path('/root/claudecode/aicom/data/secrets/vercel_token').read_text().strip()
url='https://api.vercel.com'+q['path']+('?' if '?' not in q['path'] else '&')+'teamId=${TEAM}'
req=urllib.request.Request(url,method=q['method'],headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'},data=json.dumps(q['body']).encode() if q.get('body') is not None else None)
try:
 with urllib.request.urlopen(req,timeout=40) as r: print(json.dumps({'http':r.status,'data':json.load(r)}))
except urllib.error.HTTPError as e:
 print(json.dumps({'http':e.code,'data':json.loads(e.read())}))
`;
  const result = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', 'factory-vps', 'python3', '-'],
    { input: python, encoding: 'utf8', timeout: 55000, maxBuffer: 2_000_000 });
  if (result.status !== 0) throw Error('vercel_ssh_request_failed');
  const envelope = JSON.parse(result.stdout);
  if (envelope.http >= 400) {
    const error = Error(`vercel_${envelope.http}_${envelope.data.error?.code || 'request_failed'}`);
    error.status = envelope.http; throw error;
  }
  return envelope.data;
}
const announce = data => console.log(JSON.stringify(data));
async function pageCheck(url) {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30000) });
  const html = await response.text();
  if (!response.ok || !html.includes('Sentinel Verified Safety Companion')) throw Error('sentinel_page_check_failed');
  const health = await fetch(new URL('/api/health', url), { redirect: 'error', signal: AbortSignal.timeout(30000) });
  if (!health.ok || !health.headers.get('content-type')?.includes('application/json')) throw Error('sentinel_api_health_failed');
  const healthBody = await health.json();
  if (healthBody.status !== 'ok' || healthBody.database !== 'ok') throw Error('sentinel_api_health_failed');
  return { url, status: response.status, sentinelTitle: true, apiHealth: { status: health.status, body: healthBody } };
}
async function deployment() {
  const project = await vercel('GET', `/v9/projects/${PROJECT}`);
  if (project.id !== PROJECT || project.name !== NAME || project.accountId !== TEAM || project.link) throw Error('project_identity_or_github_link_changed');
  let record = store.get('pilot', 'deployment');
  if (!record) {
    if (project.targets?.production?.id !== ORIGINAL) throw Error('production_changed_review_before_redeploy');
    await pageCheck(`https://${NAME}.vercel.app/`);
    store.put('pilot', 'deployment', { pending: true, source: ORIGINAL, at: Date.now() });
    const created = await vercel('POST', '/v13/deployments', { name: NAME, project: PROJECT, deploymentId: ORIGINAL, target: 'production' });
    if (!created.id || created.projectId !== PROJECT) throw Error('unexpected_deployment_result');
    record = store.put('pilot', 'deployment', { id: created.id, source: ORIGINAL, at: Date.now(), url: created.url });
  }
  if (!record.id) throw Error('deployment_outcome_unknown_manual_reconciliation_required');
  const latest = await vercel('GET', `/v13/deployments/${record.id}`);
  const state = latest.readyState || latest.status;
  announce({ stage: 'deployment', id: record.id, state });
  if (state !== 'READY') throw Error(`deployment_${state}_rerun_after_build`);
  if (latest.projectId !== PROJECT || latest.target !== 'production') throw Error('deployment_identity_mismatch');
  const current = await vercel('GET', `/v9/projects/${PROJECT}`);
  if (current.targets?.production?.id !== record.id) throw Error('deployment_not_current_production');
  return { id: record.id, source: record.source, ...(await pageCheck(`https://${NAME}.vercel.app/`)) };
}
async function attachDomain() {
  const path = `/v9/projects/${PROJECT}/domains/${DOMAIN}`;
  let attached;
  try { attached = await vercel('GET', path); }
  catch (e) { if (e.status !== 404) throw e; }
  if (!attached) attached = await vercel('POST', `/v10/projects/${PROJECT}/domains`, { name: DOMAIN });
  if (attached.name !== DOMAIN || attached.redirect || attached.gitBranch || attached.customEnvironmentId) throw Error('domain_binding_conflict');
  const config = await vercel('GET', `/v6/domains/${DOMAIN}/config?projectIdOrName=${PROJECT}`);
  const ips = [...(config.recommendedIPv4 || [])].sort((a, b) => a.rank - b.rank)[0]?.value;
  if (!Array.isArray(ips) || !ips.length || ips.some(ip => isIP(ip) !== 4)) throw Error('missing_vercel_ipv4_recommendation');
  const records = ips.map(content => ({ name: '', type: 'A', content }));
  for (const c of attached.verification || []) {
    if (c.type !== 'TXT' || !c.domain.endsWith(`.${DOMAIN}`) || typeof c.value !== 'string') throw Error('unsupported_verification');
    records.push({ name: c.domain.slice(0, -DOMAIN.length - 1), type: 'TXT', content: c.value });
  }
  return records;
}
async function ensureCertificate() {
  const list = await vercel('GET', '/v8/certs');
  const existing = list.certs?.find(c => c.cns?.includes(DOMAIN) && c.expiresAt > Date.now());
  if (existing) return { id: existing.id, expiresAt: existing.expiresAt };
  if (list.pagination?.next) throw Error('certificate_list_needs_pagination');
  if (store.get('pilot', 'certificate-request')) return { pending: true };
  store.put('pilot', 'certificate-request', { at: Date.now(), domain: DOMAIN });
  const cert = await vercel('POST', '/v8/certs', { cns: [DOMAIN] });
  if (!cert.cns?.includes(DOMAIN) || !cert.id) throw Error('unexpected_certificate_response');
  store.put('pilot', 'certificate', { id: cert.id, expiresAt: cert.expiresAt });
  return { id: cert.id, expiresAt: cert.expiresAt };
}
async function waitForDomain() {
  const path = `/v9/projects/${PROJECT}/domains/${DOMAIN}`;
  return waitForSetup({
    getDomain: () => vercel('GET', path),
    verifyDomain: () => vercel('POST', `${path}/verify`),
    getConfig: () => vercel('GET', `/v6/domains/${DOMAIN}/config?projectIdOrName=${PROJECT}`),
    ensureCertificate,
    checkHttps: () => pageCheck(`https://${DOMAIN}/`),
    onProgress: status => {
      const progress = { domain: DOMAIN, at: new Date().toISOString(), ...status };
      store.put('pilot', 'setup-status', progress);
      writeFileSync(join(dir, 'setup-status.json'), JSON.stringify(progress, null, 2), { mode: 0o600 });
      announce({ stage: 'setup', ...progress });
    },
  });
}
try {
  const mode = process.argv[2] || 'preflight';
  if (!['preflight', 'deploy', 'run', 'verify'].includes(mode)) throw Error('use_preflight_deploy_run_or_verify');
  if (mode === 'deploy') {
    announce(await deployment());
  } else {
    const secrets = join(homedir(), '.config/domain-kit/porkbun/production');
    const owner = new OwnerPilot({ apiKey: readFileSync(join(secrets, 'api-key'), 'utf8').trim(),
      secretKey: readFileSync(join(secrets, 'secret-key'), 'utf8').trim(), domain: DOMAIN, maxCents: 300, store });
    if (mode === 'preflight') {
      announce({ stage: 'preflight', domain: DOMAIN, ...(await owner.preflight()) });
    } else if (mode === 'verify') {
      if (!store.get('owner-writes', 'registration')?.result) throw Error('purchase_not_recorded');
      const readiness = await waitForDomain();
      announce(readiness);
      if (readiness.status !== 'ready') process.exitCode = 2;
    } else {
      const deploy = await deployment(); // no domain charge until deployment is healthy
      const prior = store.get('owner-writes', 'registration')?.result;
      const before = await owner.api('GET', '/account/balance');
      const registration = await owner.register();
      announce({ stage: 'registration', reusedReceipt: Boolean(prior), ...registration });
      // Keep the original verification records across retries, even once Vercel
      // stops returning a completed challenge.
      let desired = store.get('pilot', 'dns-target');
      if (!desired) {
        desired = await attachDomain();
        store.put('pilot', 'dns-target', desired);
      }
      const dns = await owner.configureDNS(desired);
      const readiness = await waitForDomain();
      const after = await owner.api('GET', '/account/balance');
      const spentThisRun = before.balance - after.balance;
      if (prior && spentThisRun !== 0) throw Error('unexpected_balance_change_on_repeat');
      if (!prior && spentThisRun !== registration.cost) throw Error('balance_change_requires_reconciliation');
      const evidence = { at: new Date().toISOString(), domain: DOMAIN, project: PROJECT, deployment: deploy,
        registration, dns, ...readiness,
        reusedReceipt: Boolean(prior), spentThisRun, balanceAfter: after.balance };
      store.put('pilot-runs', String(Date.now()), evidence);
      writeFileSync(join(dir, 'latest-result.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 });
      announce(evidence);
      if (readiness.status !== 'ready') process.exitCode = 2;
    }
  }
} catch (e) {
  announce({ status: 'stopped', reason: e.message }); process.exitCode = 1;
} finally {
  store.close(); closeSync(lock); unlinkSync(lockPath);
}
