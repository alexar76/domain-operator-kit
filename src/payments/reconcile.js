// Read-only reconciliation of Base USDC EIP-3009 authorizations. Never submits a transaction.
// Circle emits AuthorizationUsed immediately before that authorization's Transfer:
// https://github.com/circlefin/stablecoin-evm/blob/master/contracts/v2/EIP3009.sol
export const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
export const AUTH_USED = "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5";
export const AUTH_CANCELLED = "0x1cdd46ff242716cdaa72d159d339a485b3438398348d68f09d7c8c0a59353d81";
export const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const address = /^0x[0-9a-f]{40}$/i, hash = /^0x[0-9a-f]{64}$/i;
const lower = value => String(value || "").toLowerCase();
const word = value => lower(value).slice(2).padStart(64, "0");
const hex = value => "0x" + BigInt(value).toString(16);
const quantity = value => {
  if (!/^0x[0-9a-f]+$/i.test(String(value))) throw new Error("invalid RPC quantity");
  return BigInt(value);
};
const pending = (reason, cursor) => ({ status: "pending", reason, ...(cursor ? { nextBlock: cursor } : {}) });

function validate(a) {
  if (!a || !address.test(a.from) || !address.test(a.to) || !hash.test(a.nonce)
      || !/^\d+$/.test(String(a.value)) || BigInt(a.value) <= 0n
      || !/^\d+$/.test(String(a.validBefore)) || !/^\d+$/.test(String(a.validAfter ?? "0"))
      || BigInt(a.validBefore) <= BigInt(a.validAfter ?? "0")) throw new Error("invalid authorization terms");
}

// Public fallback: https://drpc.org/docs/base-api — limited history/rate; use BASE_RPC with archive access for production.
export function createBaseReconciler({ rpcUrl = "https://base.drpc.org", fetchImpl = globalThis.fetch,
                                       batchBlocks = 10, maxBatches = 4 } = {}) {
  // Small ranges also work with restrictive public RPC plans; larger archive scans are opt-in.
  if (!Number.isSafeInteger(batchBlocks) || batchBlocks < 1 || !Number.isSafeInteger(maxBatches) || maxBatches < 1) throw new Error("invalid scan bounds");
  let id = 0;
  const rpc = async (method, params) => {
    const res = await fetchImpl(rpcUrl, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }), signal: AbortSignal.timeout(12_000) });
    if (!res.ok) throw new Error("reconciliation RPC unavailable");
    const json = await res.json();
    if (json.error || !("result" in json)) throw new Error("reconciliation RPC refused request");
    return json.result;
  };
  const chain = async () => { if (quantity(await rpc("eth_chainId", [])) !== 8453n) throw new Error("reconciliation RPC is not Base"); };
  const block = async tag => {
    const b = await rpc("eth_getBlockByNumber", [tag, false]);
    if (!b || !hash.test(b.hash)) throw new Error("finalized block unavailable");
    return { ...b, height: quantity(b.number), time: quantity(b.timestamp) };
  };

  return {
    /** Save this checkpoint BEFORE settlement. No signatures or private keys are needed later. */
    async prepare(auth, expected) {
      validate(auth);
      if (lower(auth.to) !== lower(expected.to) || BigInt(auth.value) !== BigInt(expected.value)) throw new Error("wrong reconciliation terms");
      await chain();
      const head = quantity(await rpc("eth_blockNumber", []));
      return { chainId: 8453, asset: BASE_USDC, from: lower(auth.from), to: lower(auth.to), nonce: lower(auth.nonce),
        value: String(auth.value), validAfter: String(auth.validAfter ?? "0"), validBefore: String(auth.validBefore),
        fromBlock: hex(head > 64n ? head - 64n : 0n) };
    },

    /** Only finalized chain evidence can return paid/unpaid. Any incomplete evidence stays pending. */
    async resolve(a) {
      try {
        validate(a);
        if (a.chainId !== 8453 || lower(a.asset) !== BASE_USDC) return pending("unsupported_terms");
        const start = quantity(a.fromBlock), cursor = quantity(a.nextBlock || a.fromBlock);
        if (cursor < start) return pending("invalid_cursor");
        await chain();
        const final = await block("finalized");
        const used = await rpc("eth_call", [{ to: BASE_USDC, data: "0xe94a0102" + word(a.from) + a.nonce.slice(2) }, final.number]);
        if (!/^0x0{63}[01]$/i.test(String(used))) return pending("invalid_authorization_state");
        if (BigInt(used) === 0n) {
          if (final.time < BigInt(a.validBefore)) return pending("not_finalized_or_still_valid");
          // Prove the checked block is still canonical before deciding no future transfer can land.
          if ((await block(final.number)).hash !== final.hash) return pending("chain_changed");
          return { status: "unpaid", reason: "expired_unused", block: final.number };
        }
        let from = cursor;
        for (let n = 0; n < maxBatches && from <= final.height; n++) {
          const to = from + BigInt(batchBlocks - 1) < final.height ? from + BigInt(batchBlocks - 1) : final.height;
          const logs = await rpc("eth_getLogs", [{ address: BASE_USDC, fromBlock: hex(from), toBlock: hex(to),
            topics: [[AUTH_USED, AUTH_CANCELLED], "0x" + word(a.from), lower(a.nonce)] }]);
          if (!Array.isArray(logs)) return pending("invalid_logs");
          for (const event of logs) {
            if (event.removed || lower(event.address) !== BASE_USDC || lower(event.topics?.[1]) !== "0x" + word(a.from)
                || lower(event.topics?.[2]) !== lower(a.nonce) || ![AUTH_USED, AUTH_CANCELLED].includes(lower(event.topics?.[0]))) continue;
            if (!hash.test(event.transactionHash)) return pending("invalid_transaction");
            const receipt = await rpc("eth_getTransactionReceipt", [event.transactionHash]);
            if (!receipt || receipt.status !== "0x1" || lower(receipt.transactionHash) !== lower(event.transactionHash)
                || quantity(receipt.blockNumber) > final.height || receipt.blockHash !== event.blockHash
                || (await block(receipt.blockNumber)).hash !== receipt.blockHash) return pending("receipt_not_finalized");
            const ownLogs = (receipt.logs || []).filter(l => lower(l.address) === BASE_USDC).sort((x, y) => Number(quantity(x.logIndex) - quantity(y.logIndex)));
            const at = ownLogs.findIndex(l => l.logIndex === event.logIndex && lower(l.topics?.[0]) === lower(event.topics?.[0])
              && lower(l.topics?.[1]) === "0x" + word(a.from) && lower(l.topics?.[2]) === lower(a.nonce) && !l.removed);
            if (at < 0) return pending("event_not_in_receipt");
            if (lower(event.topics[0]) === AUTH_CANCELLED) return { status: "unpaid", reason: "authorization_cancelled", transaction: receipt.transactionHash };
            const transfer = ownLogs[at + 1];
            if (!transfer || transfer.removed || lower(transfer.topics?.[0]) !== TRANSFER
                || lower(transfer.topics?.[1]) !== "0x" + word(a.from) || lower(transfer.topics?.[2]) !== "0x" + word(a.to)
                || quantity(transfer.data) !== BigInt(a.value)) return pending("transfer_terms_mismatch");
            return { status: "paid", transaction: receipt.transactionHash, block: receipt.blockNumber };
          }
          from = to + 1n;
        }
        return pending(from > final.height ? "consumed_without_matching_event" : "scan_in_progress", hex(from > final.height ? start : from));
      } catch { return pending("rpc_or_evidence_unavailable"); }
    },
  };
}

/** One immediately started, non-overlapping worker. Stop returns a promise for the active pass. */
export function startReconciliation(run, { intervalMs = 30_000, log = console } = {}) {
  if (!Number.isFinite(intervalMs) || intervalMs < 1000) throw new Error("reconciliation interval must be at least 1000 ms");
  let active = null;
  const tick = () => {
    if (!active) active = Promise.resolve().then(run).catch(() => log.error?.("reconciliation pass failed; retained pending records"))
      .finally(() => { active = null; });
    return active;
  };
  const timer = setInterval(tick, intervalMs); timer.unref(); tick();
  return { tick, stop: async () => { clearInterval(timer); await active; } };
}
