import { createServer } from 'node:http';
import { authenticate, canonical, digest, DomainError, object, fail } from './core.js';
import { CONTRACT, listing } from './contract.js';

export function createHttpServer(service, { requestsPerMinute = 120, maxConcurrent = 32 } = {}) {
  const rates = new Map(); let active = 0;
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const send = (status, value) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    let counted = false;
    try {
      const key = req.socket.remoteAddress, now = Date.now();
      if (rates.size > 10000) for (const [k, v] of rates) if (now - v.at > 60000) rates.delete(k);
      const rate = rates.get(key); const next = rate && now - rate.at < 60000 ? { at: rate.at, count: rate.count + 1 } : { at: now, count: 1 };
      rates.set(key, next);
      if (next.count > requestsPerMinute || active >= maxConcurrent) { res.setHeader('Retry-After', '60'); return send(429, { success: false, error: 'rate_limited' }); }
      active++; counted = true;
      const path = new URL(req.url, 'http://localhost').pathname;
      if (req.method === 'GET' && path === '/healthz') return send(200, { ok: true, mode: service.mode, supplier: service.provider.kind,
        orders: service.refusesOrders ? 'refused_demo' : service.mode === 'live' ? 'live' : 'simulated',
        ...(service.liveMissing.length ? { live_missing: service.liveMissing } : {}),
        real_payments: service.payments.kind === 'x402', provider_pubkey: service.signer.publicKey,
        pending_orders: service.store.all('orders').filter(o => !['delivered', 'refunded', 'cancelled', 'awaiting_payment'].includes(o.state)).length });
      if (req.method === 'GET' && path === '/listing.json') return send(200, listing(service));
      if (req.method !== 'POST') return send(405, { success: false, error: 'method_not_allowed' });
      const route = CONTRACT.find(c => c.path === path || (path === '/quote/invoke' && c.key === 'quote'));
      if (!route) return send(404, { success: false, error: 'not_found' });
      // Before owner authentication, so an agent without a key still learns why it cannot buy here.
      if (service.refusesOrders && ['register', 'renew'].includes(route.key)) fail('demo_mode', 403);
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) fail('json_required', 415);
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 32768) fail('body_too_large', 413); chunks.push(chunk); }
      const raw = Buffer.concat(chunks).toString('utf8');
      let body; try { body = JSON.parse(raw); } catch { fail('invalid_json'); }
      if (!object(body)) fail('invalid_input');
      const wrapped = path === '/quote/invoke';
      const input = wrapped ? body.input : body;
      if (!object(input)) fail('invalid_input');
      if (wrapped && ((body.capability_id && body.capability_id !== route.capability_id) || (body.product_id && body.product_id !== service.productId))) fail('wrong_capability');
      // Hub discovery carries no private identity. Renewal quotes always go directly to seller.
      if (wrapped && input.operation && input.operation !== 'register') fail('private_operation_requires_direct_route', 403);
      let owner = null;
      if (!route.public || input.operation === 'renew') owner = authenticate(req.headers, service.origin, path, body, service.store, service.now());
      let result;
      if (['register', 'renew'].includes(route.key)) result = await service.order(input, owner, route.key, req.headers['payment-signature']);
      else result = await service[route.key](input, owner);
      const bound = { capability_id: route.capability_id, product_id: service.productId, input_sha256: digest(input), result };
      res.setHeader('X-Provider-Signature', service.signer.sign(canonical(bound)));
      if (result?.payment_required && service.payments.kind !== 'demo') {
        res.setHeader('PAYMENT-REQUIRED', Buffer.from(JSON.stringify(result.payment_required)).toString('base64'));
        return send(402, { success: false, error: 'payment_required', result });
      }
      if (result?.payment_transaction && service.payments.kind === 'x402') res.setHeader('PAYMENT-RESPONSE', Buffer.from(JSON.stringify({ success: true, transaction: result.payment_transaction, network: 'eip155:8453' })).toString('base64'));
      return send(result?.status && !['delivered', 'refunded', 'cancelled'].includes(result.status) && route.key !== 'info' ? 202 : 200, { success: true, result });
    } catch (error) {
      // Registrar errors may contain contact PII or credentials: never echo exception messages.
      if (!res.headersSent) send(error instanceof DomainError ? error.status : 500,
        { success: false, error: error instanceof DomainError ? error.code : 'internal_error' });
      else res.end();
    } finally { if (counted) active--; }
  });
  server.requestTimeout = 30000; server.headersTimeout = 10000; server.keepAliveTimeout = 5000;
  return server;
}
