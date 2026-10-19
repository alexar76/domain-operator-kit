import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBaseReconciler, startReconciliation, BASE_USDC, AUTH_USED, AUTH_CANCELLED, TRANSFER } from '../src/payments/reconcile.js';

const from = '0x' + 'ab'.repeat(20), to = '0x' + '12'.repeat(20), nonce = '0x' + '11'.repeat(32);
const hash = '0x' + '22'.repeat(32), tx = '0x' + '33'.repeat(32);
const word = x => '0x' + x.slice(2).padStart(64, '0');
const auth = { from, to, nonce, value: '1000000', validAfter: '0', validBefore: '1000' };
const checkpoint = { ...auth, chainId: 8453, asset: BASE_USDC, fromBlock: '0x40' };
function fixture(options = {}) {
  const calls = [];
  const event = { address: BASE_USDC, topics: [options.cancel ? AUTH_CANCELLED : AUTH_USED, word(from), nonce],
    transactionHash: tx, blockHash: hash, blockNumber: '0x50', logIndex: '0x1' };
  const transfer = { address: BASE_USDC, topics: [TRANSFER, word(from), word(to)], data: '0xf4240', logIndex: '0x2' };
  const receipt = { transactionHash: tx, status: '0x1', blockHash: hash, blockNumber: '0x50', logs: [event, transfer] };
  options.mutate?.({ event, transfer, receipt });
  const reader = createBaseReconciler({ batchBlocks: options.batchBlocks, maxBatches: options.maxBatches,
    fetchImpl: async (_url, init) => {
      const { method, params } = JSON.parse(init.body); calls.push({ method, params });
      if (options.fail === method) throw Error('RPC unavailable');
      let result;
      switch (method) {
        case 'eth_chainId': result = options.chain || '0x2105'; break;
        case 'eth_blockNumber': result = '0x80'; break;
        case 'eth_getBlockByNumber': result = { number: params[0] === 'finalized' ? '0x60' : params[0],
          timestamp: options.time || '0x400', hash: options.reorg && params[0] !== 'finalized' ? tx : hash }; break;
        case 'eth_call': result = word(options.unused ? '0x0' : '0x1'); break;
        case 'eth_getLogs': result = options.noLogs || BigInt(event.blockNumber) < BigInt(params[0].fromBlock) || BigInt(event.blockNumber) > BigInt(params[0].toBlock) ? [] : [event]; break;
        case 'eth_getTransactionReceipt': result = receipt; break;
        default: throw Error('unexpected RPC');
      }
      return Response.json({ result });
    } });
  return { reader, calls };
}

test('checkpoint binds exact terms and chain before a transfer can be submitted', async () => {
  const { reader } = fixture();
  assert.deepEqual(await reader.prepare(auth, { to, value: '1000000' }), checkpoint);
  await assert.rejects(reader.prepare(auth, { to: from, value: '1000000' }), /terms/);
  await assert.rejects(reader.prepare(auth, { to, value: '1' }), /terms/);
  await assert.rejects(fixture({ chain: '0x1' }).reader.prepare(auth, { to, value: auth.value }), /not Base/);
});

test('paid requires finalized authorization and its adjacent exact USDC transfer', async () => {
  const live = fixture();
  assert.equal((await live.reader.resolve(checkpoint)).status, 'paid');
  for (const call of live.calls.filter(x => x.method === 'eth_getLogs')) assert.ok(BigInt(call.params[0].toBlock) - BigInt(call.params[0].fromBlock) < 10n, 'public-RPC-compatible default range');
  const mutations = [
    ({ transfer }) => { transfer.topics[1] = word(to); },
    ({ transfer }) => { transfer.topics[2] = word(from); },
    ({ transfer }) => { transfer.data = '0x1'; },
    ({ transfer }) => { transfer.address = to; },
    ({ transfer }) => { transfer.removed = true; },
    ({ receipt }) => { receipt.blockNumber = '0x70'; },
    ({ receipt }) => { receipt.status = '0x0'; },
    ({ event }) => { event.topics[2] = hash; },
    ({ receipt }) => { receipt.logs.splice(1, 0, { address: BASE_USDC, logIndex: '0x2', topics: [AUTH_USED, word(from), hash] }); receipt.logs[2].logIndex = '0x3'; },
  ];
  for (const mutate of mutations) assert.equal((await fixture({ mutate }).reader.resolve(checkpoint)).status, 'pending');
  assert.equal((await fixture({ reorg: true }).reader.resolve(checkpoint)).status, 'pending');
});

test('only finalized expiration with an unused nonce, or a finalized cancellation, proves unpaid', async () => {
  assert.equal((await fixture({ unused: true }).reader.resolve(checkpoint)).reason, 'expired_unused');
  assert.equal((await fixture({ unused: true, time: '0x100' }).reader.resolve(checkpoint)).status, 'pending');
  assert.equal((await fixture({ unused: true, reorg: true }).reader.resolve(checkpoint)).status, 'pending');
  assert.equal((await fixture({ cancel: true }).reader.resolve(checkpoint)).reason, 'authorization_cancelled');
  assert.equal((await fixture({ cancel: true, mutate: ({ event }) => { event.topics[2] = hash; } }).reader.resolve(checkpoint)).status, 'pending');
});

test('outages, incomplete legacy checkpoints and wrong chains never resolve as unpaid', async () => {
  for (const fail of ['eth_chainId', 'eth_getBlockByNumber', 'eth_call', 'eth_getLogs', 'eth_getTransactionReceipt']) {
    assert.equal((await fixture({ fail }).reader.resolve(checkpoint)).status, 'pending');
  }
  assert.equal((await fixture({ chain: '0x1' }).reader.resolve(checkpoint)).status, 'pending');
  assert.equal((await fixture().reader.resolve(auth)).status, 'pending');
});

test('bounded scans resume from a persisted cursor and restart an exhausted search', async () => {
  const { reader, calls } = fixture({ noLogs: true, batchBlocks: 8, maxBatches: 1 });
  let r = await reader.resolve(checkpoint);
  assert.equal(r.nextBlock, '0x48'); assert.equal(r.reason, 'scan_in_progress');
  r = await reader.resolve({ ...checkpoint, nextBlock: r.nextBlock });
  assert.equal(calls.filter(x => x.method === 'eth_getLogs')[1].params[0].fromBlock, '0x48');
  r = await reader.resolve({ ...checkpoint, nextBlock: '0x60' });
  assert.equal(r.nextBlock, checkpoint.fromBlock); assert.equal(r.status, 'pending');
});

test('worker starts immediately, does not overlap, and stop waits for active work', async () => {
  let finish, calls = 0;
  const worker = startReconciliation(async () => { calls++; await new Promise(resolve => { finish = resolve; }); }, { log: {} });
  await Promise.resolve(); worker.tick(); worker.tick();
  assert.equal(calls, 1);
  let stopped = false; const done = worker.stop().then(() => { stopped = true; });
  await Promise.resolve(); assert.equal(stopped, false); finish(); await done;
  assert.equal(stopped, true);
});
