#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { signer, secureUrl } from '../src/core.js';
import { Store } from '../src/store.js';
import { DomainClient, x402PaymentSigner } from '../src/client.js';
import { CONTRACT, nodeToml } from '../src/contract.js';
import { VercelConnector } from '../src/vercel.js';

const [command, ...args] = process.argv.slice(2);
async function clientFromEnv() {
  const env = process.env;
  const dir = resolve(env.DOMAIN_BUYER_DATA_DIR || './data/buyer'); mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, 'encryption.key');
  if (!existsSync(path)) writeFileSync(path, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
  const store = new Store(join(dir, 'buyer.sqlite'), Buffer.from(readFileSync(path, 'utf8').trim(), 'hex'));
  const key = signer(readFileSync(env.DOMAIN_OWNER_KEY_FILE, 'utf8'));
  const paymentSigner = env.DOMAIN_BUYER_KEY_FILE ? await x402PaymentSigner(readFileSync(env.DOMAIN_BUYER_KEY_FILE, 'utf8').trim(), env.DOMAIN_BUY_MAX_USD || '0') : null;
  return new DomainClient({ url: env.DOMAIN_SELLER_URL, sellerKey: env.DOMAIN_SELLER_KEY, productId: env.DOMAIN_SELLER_PRODUCT,
    ownerKey: key, paymentSigner, store, maxPurchaseUsd: env.DOMAIN_BUY_MAX_USD || '0', dailyBudgetUsd: env.DOMAIN_BUY_DAILY_USD || '0',
    allowDemo: env.DOMAIN_ALLOW_DEMO === '1', allowLocal: env.DOMAIN_ALLOW_DEMO === '1' });
}

async function main() {
  if (command === 'init-owner') {
    const key = signer(); const path = resolve(args[0] || 'owner.pem');
    writeFileSync(path, key.pem, { flag: 'wx', mode: 0o600 }); console.log(JSON.stringify({ file: path, public_key: key.publicKey })); return;
  }
  if (command === 'schemas') { console.log(JSON.stringify(CONTRACT, null, 2)); return; }
  if (command === 'check') {
    const url = secureUrl(args[0], process.env.DOMAIN_ALLOW_DEMO === '1');
    const response = await fetch(`${url}/listing.json`, { redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw Error('Seller listing unavailable');
    const l = await response.json();
    const c = new DomainClient({ url, sellerKey: l.seller.provider_pubkey, productId: l.seller.product_id, allowLocal: process.env.DOMAIN_ALLOW_DEMO === '1', allowDemo: true });
    const quote = await c.call('quote', { domain: args[1] || 'example.com' });
    console.log(JSON.stringify({ ok: true, protocol: l.protocol, mode: l.mode, seller: l.seller, quote,
      note: 'Read-only protocol check; seller key is self-asserted here. Pin it through a trusted catalogue before purchases. No delivery or ownership guarantee.' }, null, 2)); return;
  }
  if (command === 'node-toml') {
    const url = secureUrl(args[0], process.env.DOMAIN_ALLOW_DEMO === '1');
    const res = await fetch(`${url}/listing.json`, { redirect: 'error', signal: AbortSignal.timeout(15000) }); const l = await res.json();
    console.log(nodeToml({ sellerName: l.seller.name, productId: l.seller.product_id, mode: l.mode, signer: { publicKey: l.seller.provider_pubkey } }, secureUrl(args[1]), args[2] || url)); return;
  }
  if (command === 'call') {
    const c = await clientFromEnv();
    try {
      const input = JSON.parse(readFileSync(args[1], 'utf8'));
      const result = args[0] === 'vercelConnect' ? await vercel(c).connect(input) : await c.call(args[0], input);
      console.log(JSON.stringify(result, null, 2));
    }
    finally { c.store.close(); }
    return;
  }
  if (command === 'mcp') {
    const c = await clientFromEnv();
    // newline-delimited JSON-RPC over stdio, as required by MCP's stdio transport.
    const out = value => process.stdout.write(`${JSON.stringify(value)}\n`);
    const toolContracts = CONTRACT.filter(r => r.key !== 'transferCode').map(r => {
      const schema = structuredClone(r.input);
      if (r.key === 'register' && process.env.DOMAIN_REGISTRANT_FILE) { delete schema.properties.registrant; schema.required = schema.required.filter(k => k !== 'registrant'); }
      return { name: r.key, description: r.description, inputSchema: schema,
        annotations: { readOnlyHint: ['quote', 'status', 'info', 'dnsGet'].includes(r.key), destructiveHint: ['register', 'renew', 'dnsSet'].includes(r.key), openWorldHint: true } };
    });
    if (process.env.VERCEL_TOKEN_FILE && process.env.VERCEL_PROJECT_ID) toolContracts.push({ name: 'vercelConnect',
      description: 'Connect an owned apex domain to the configured Vercel project. Reads Vercel DNS recommendations, preserves other records. Existing A records require explicit replace_existing=true; does not buy domains.',
      inputSchema: { type: 'object', additionalProperties: false, required: ['domain'], properties: { domain: { type: 'string' }, replace_existing: { type: 'boolean', default: false } } },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true } });
    const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of lines) {
      let request;
      try {
        if (Buffer.byteLength(line) > 65536) throw Error('Request too large');
        request = JSON.parse(line); if (request.id === undefined) continue;
        let result;
        if (request.method === 'initialize') result = { protocolVersion: '2024-11-05', serverInfo: { name: 'domain-rails', version: '0.1.0' }, capabilities: { tools: {} } };
        else if (request.method === 'ping') result = {};
        else if (request.method === 'tools/list') result = { tools: toolContracts };
        else if (request.method === 'tools/call') {
          if (!toolContracts.some(t => t.name === request.params?.name)) throw Error('Unknown tool');
          try {
            const input = request.params.arguments || {};
            if (request.params.name === 'register' && process.env.DOMAIN_REGISTRANT_FILE) input.registrant = JSON.parse(readFileSync(process.env.DOMAIN_REGISTRANT_FILE, 'utf8'));
            const answer = request.params.name === 'vercelConnect' ? await vercel(c).connect(input) : await c.call(request.params.name, input);
            result = { content: [{ type: 'text', text: JSON.stringify(answer) }] };
          } catch (error) { result = { isError: true, content: [{ type: 'text', text: error.code || 'domain_operation_failed' }] }; }
        } else { out({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } }); continue; }
        out({ jsonrpc: '2.0', id: request.id, result });
      } catch { out({ jsonrpc: '2.0', id: request?.id ?? null, error: { code: -32600, message: 'Invalid request' } }); }
    }
    c.store.close(); return;
  }
  console.log('domain-rails init-owner [file] | schemas | check SELLER_URL [domain] | node-toml SELLER_URL NODE_URL [upstream] | call TOOL INPUT.json | mcp');
}
function vercel(client) {
  return new VercelConnector({ client, token: readFileSync(process.env.VERCEL_TOKEN_FILE, 'utf8').trim(), project: process.env.VERCEL_PROJECT_ID, team: process.env.VERCEL_TEAM_ID });
}
main().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
