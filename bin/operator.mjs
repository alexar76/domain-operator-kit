#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Store } from '../src/store.js';
import { digest } from '../src/core.js';

const [command, evidencePath] = process.argv.slice(2), dir = resolve(process.env.DOMAIN_DATA_DIR || './data');
if (!['report', 'record-evidence'].includes(command)) throw Error('Usage: node bin/operator.mjs report | record-evidence evidence.json');
// Operator actions run offline, including reports, so they never race a live mutation.
if (existsSync(join(dir, 'server.lock'))) throw Error('Stop the seller first. A stale lock requires confirming no seller process uses this database.');
const db = join(dir, 'orders.sqlite'); if (!existsSync(db)) throw Error('Existing seller database required');
const key = Buffer.from(readFileSync(process.env.DOMAIN_DATA_KEY_FILE || join(dir, 'encryption.key'), 'utf8').trim(), 'hex');
const store = new Store(db, key);
try {
  if (command === 'report') {
    console.log(JSON.stringify(store.all('orders').map(o => ({ order_id: o.id, domain: o.domain, operation: o.operation,
      status: o.state, updated_at: new Date(o.updated_at).toISOString(), price_usd: o.price_usd,
      payment_transaction: o.payment?.transaction || null, refund_transaction: o.refund?.transaction || null, reason: o.reason || null })), null, 2));
  } else {
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
    const order = store.get('orders', evidence.order_id || '');
    if (!order || order.state !== 'registration_pending' || order.domain !== evidence.domain) throw Error('Evidence must identify an existing pending registrar order and its exact domain');
    if (!['registrar_confirmed_no_registration_or_renewal', 'registrar_confirmed_this_renewal'].includes(evidence.conclusion)
      || typeof evidence.reference !== 'string' || evidence.reference.length < 8 || evidence.reference.length > 2000
      || typeof evidence.checked_by !== 'string' || !evidence.checked_by.trim()
      || !Number.isFinite(Date.parse(evidence.checked_at)) || Math.abs(Date.now() - Date.parse(evidence.checked_at)) > 86400000) throw Error('Fresh explicit registrar evidence, reference and operator attribution required');
    if (evidence.conclusion === 'registrar_confirmed_this_renewal' && order.operation !== 'renew') throw Error('Renewal confirmation only applies to renewal orders');
    if (store.get('operator-evidence', order.id)) throw Error('Evidence already exists; conflicting evidence requires an audited maintenance procedure');
    store.transaction(() => {
      store.put('operator-evidence', order.id, evidence);
      if (evidence.conclusion === 'registrar_confirmed_this_renewal') store.put('registrar-acks', order.id, { accepted: true, operator_evidence_sha256: digest(evidence) });
    });
    console.log(JSON.stringify({ recorded: true, order_id: order.id, evidence_sha256: digest(evidence), note: 'No money or registrar mutation executed. Restart seller to reconcile.' }));
  }
} finally { store.close(); }
