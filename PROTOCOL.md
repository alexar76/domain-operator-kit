# domains/v1 protocol

The stable capability names and JSON input schemas are in [spec/domains-v1.json](spec/domains-v1.json). The seller base URL is configured and pinned; redirect following is disabled. Money is a decimal string with at most six fractional digits. Only a one-year period is supported.

## Public discovery

`GET /listing.json` publishes the seller identity, supported TLDs, fixed markup and direct endpoints. `POST /quote` accepts `{"domain":"example.com"}`. `POST /quote/invoke` accepts a Hub envelope with `input`, optional matching `product_id` and `capability_id`. Only registration quotes are permitted through Hub. Renewal quotes require owner authentication and use `/quote` directly.

A positive quote contains `quote_id`, normalized `domain`, `operation`, `period_years`, `cost_usd`, `markup_usd`, `price_usd`, `renewal_estimate_usd`, `expires_at`, seller identity, terms version/URL, `order_url`, and `mode`. `domain_reserved` and `renewal_price_guaranteed` are false. Quote TTL defaults to five minutes. Unavailability returns `available:false`; malformed input, unsupported TLD and premium names return errors. Do not treat API errors as availability results.

## Canonical JSON and signatures

`src/core.js` is the reference encoder: object keys sorted lexicographically, compact JSON, arrays in original order, UTF-8, no ASCII escaping of Unicode. Avoid non-JSON values. Hashes are lowercase SHA-256 hex. Ed25519 public keys are raw 32 bytes encoded as standard Base64; signatures are standard Base64 of 64 bytes.

Every successful response, including an order's payment-required response, carries `X-Provider-Signature` over canonical JSON:

```json
{"capability_id":"domains.quote@v1","product_id":"domains-operator","input_sha256":"SHA256_CANONICAL_INPUT","result":{}}
```

`input_sha256` is the capability input, not the Hub envelope. The response body is `{"success":true,"result":...}`; a 402 order response uses `success:false` but the same signed `result` envelope. Errors without `result` are not signed and never authorize a payment. Quotes and delivery receipts also have dedicated signatures.

Private operations require these headers:

| Header | Value |
|---|---|
| `X-Domain-Owner` | Owner Ed25519 public key |
| `X-Domain-Time` | Unix seconds as decimal text |
| `X-Domain-Nonce` | Fresh 24 random bytes encoded Base64url without padding |
| `X-Domain-Signature` | Owner signature of the object below |

```json
{"v":1,"audience":"https://domains.seller.example","method":"POST","path":"/register","body_sha256":"SHA256_CANONICAL_BODY","timestamp":"1790000000","nonce":"32_CHARACTER_BASE64URL_NONCE_____"}
```

The audience is the exact configured seller base URL, without trailing slash. The path is the exact capability route. Timestamp tolerance is 300 seconds, and nonces are consumed once. A retry generates fresh request headers but retains the order body and payment authorization.

The key controls management API access. Registry ownership is the real registrant contact, not the key or paying wallet. Contact changes and owner-key recovery are operator support procedures in v1; never regenerate a key assuming the old domains will follow it.

## Paid orders

`POST /register` takes `quote_id`, `client_order_id` (16–80 alphanumeric, underscore or hyphen), `accept_terms:true`, `terms_version`, and `registrant`. `/renew` takes the same fields without `registrant`, using a private renewal quote. The server ID is SHA-256 of `ownerPublicKey + ':' + client_order_id`. Reuse with different arguments is `409 idempotency_conflict`. Persist the exact order body before sending it.

Live mode first returns 402 with `PAYMENT-REQUIRED` (Base64 JSON) and the same challenge inside the signed result. Requirements use x402 v2, exact USDC, Base mainnet `eip155:8453`, and the order amount in atomic USDC units. The buyer obtains a standard EIP-3009 `TransferWithAuthorization` payload. The kit supports this scheme, not Permit2, session keys or arbitrary assets.

**Domain orders additionally bind the paying wallet to the order and owner.** The challenge includes `order_id` and `domain_order_binding: {protocol, origin, owner}`. The buyer wallet signs the following canonical JSON with EIP-191 personal-sign:

```json
{"protocol":"domain-payment-order/1","origin":"https://domains.seller.example","order_id":"SERVER_ORDER_ID","owner":"OWNER_ED25519_PUBLIC_KEY","nonce":"EIP3009_AUTHORIZATION_NONCE"}
```

Attach the hex signature as `domainOrderProof` on the x402 payload, then send its Base64 JSON as `PAYMENT-SIGNATURE`. The server verifies recovery to the payer before settlement. This extra field is removed before forwarding the standard payload to the facilitator. A stock x402 client without this binding is insufficient; the included `DomainClient` and MCP client implement it. Refunds are generated internally and do not use this purchase binding.

Before settlement, the seller rechecks availability and price, verifies payment, prepares a chain-recovery checkpoint, and transactionally binds the authorization nonce and domain to the order. Only then is settlement attempted. After payment, it rechecks supplier availability/price and submits registration once. A price increase or definite inability to start registration leads to refund of the original amount, not an additional charge.

`202` means pending; it is not evidence of failure. Reuse the same `client_order_id` or call `/status` with `order_id`. A delivered response contains sanitized domain information and a signed receipt. `PAYMENT-RESPONSE` carries the settlement transaction if known.

## State machine

```text
awaiting_payment → settlement_pending → paid → preparing → registration_pending → delivered
                          │                       │                  │
                          └→ cancelled            └──────┬───────────┘
                                             only proven non-delivery
                                                        ↓
                       refunded ← refund_pending ← refund_preparing ← refund_due
                                      │                    │
                                      ↓                    └→ refund_due (never submitted)
                                  refund_review
```

Lost settlement replies are resolved by finalized Base authorization/transfer evidence. Lost registration replies are resolved by provider evidence. Neither `submit` nor settlement is blindly repeated. An unsubmitted refund can be safely prepared again; an attempted refund cannot. `refund_review` means the original refund expired unused according to chain evidence and needs operator review; v1 does not automatically issue its replacement.

## DNS semantics

`dnsGet` returns `records` and a SHA-256 `revision`. `dnsSet` requires that revision and 1–50 records. Names are FQDNs inside the owned zone, or `@` for its apex. Types: A, AAAA, CNAME, TXT, MX, CAA. MX requires integer `prio`. General TTL is 60–86400; Openprovider accepts only 900, 3600, 10800, 21600, 43200 or 86400 and rejects other TTLs through this adapter.

Each supplied `(name,type)` replaces that whole record set. For a TXT change, include every TXT value you want retained at that name. Other names and types remain untouched. No zone replacement, deletion, wildcard certificate automation, DNSSEC change or nameserver change is provided. Apex CNAME and conflicting CNAME records are refused. Read after any timeout before deciding whether another DNS update is needed.

## Error handling

400 invalid fields/format; 401 invalid owner proof; 403 private route or buyer policy restriction; 404 unknown/not-owned resource; 409 stale quote/revision, duplicate nonce, conflicting order or ownership state; 422 unsupported domain/operation; 429 rate limited; 5xx uncertain infrastructure/provider failure. Error messages contain a code, not registrar exception text or contact details.

Health is liveness only: `GET /healthz` does not prove registrar reachability, funded wallets, or successful delivery. No private API supports reading all customer orders.
