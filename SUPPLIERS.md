# Independent supplier integration

An operator can run its own seller node or use an HTTP bridge to a backend in any language. The Hub does not need registrar credentials or private buyer data. Built-in registrars are Openprovider and [Porkbun Sandbox](PORKBUN.md); adding others does not change the public `domains.*@v1` contract.

## HTTP authentication

Set `DOMAIN_PROVIDER=http`, `DOMAIN_SUPPLIER_URL`, `DOMAIN_SUPPLIER_SECRET_FILE`, `DOMAIN_TLDS` and `DOMAIN_SUPPLIER_FEATURES`. A secret must contain at least 32 characters. Use a distinct random secret per operator. Production URLs require HTTPS. Paths below are appended to the configured base URL.

Every request is POST with canonical JSON, `X-Kit-Time` in milliseconds, and `X-Kit-Signature` as hex HMAC-SHA256:

```text
timestamp + '.POST.' + path + '.' + canonicalJson(body)
```

Verify in constant time, enforce a bounded timestamp window, reject replayed mutations durably, and retain business idempotency independently of replay protection. Respond with JSON. No redirects are followed. Each request attempt times out at 20 seconds. Reads retry once after 250 ms on transport failures or HTTP 429/500/502/503/504. Mutations never retry automatically; a timeout after a mutation is an unknown outcome. Authentication refusals do not retry.

## Required endpoints

| Path | Input | Output |
|---|---|---|
| `/quote` | `domain`, `operation:register\|renew`, `period_years:1` | `{available,currency:"USD",cost_usd,renewal_cost_usd,premium:false,period_years:1}` |
| `/prepare` | `registrant`, `order_id` | `{customer_handle:"..."}` |
| `/submit` | Supplier order below | Delivered, pending or definitively failed result |
| `/reconcile` | The same supplier order | Read-only evidence about that exact order |
| `/info` | `{domain,provider_domain_id,prepared}` | Domain information below |

Optional features: `dns` enables `/dns/get` and `/dns/set`; `transfer_code` enables `/transfer-code`.

Supplier order:

```json
{
  "id": "STABLE_SELLER_ORDER_ID",
  "domain": "example.com",
  "operation": "register",
  "period_years": 1,
  "prepared": {"customer_handle":"BUYER_CONTACT"},
  "provider_domain_id": null,
  "before_expiry": null,
  "max_cost_usd": "10.000000"
}
```

Domain information:

```json
{
  "domain": "example.com",
  "provider_domain_id": "REGISTRAR_ID",
  "status": "active",
  "expires_at": "2027-10-18T12:00:00Z",
  "nameservers": ["ns1.supplier.example", "ns2.supplier.example"],
  "action_required": null,
  "autorenew": false
}
```

Return `{"status":"delivered","domain":...}` only after the registrar confirms the exact operation and owner. Use `action_required:"verify_registrant_email"` when needed. An increased expiry on its own does not prove which renewal caused it.

Return `{"status":"pending"}` when uncertain. Return `{"status":"failed","definite":true}` only when there is positive evidence that this operation did not and cannot subsequently complete. A transport error, “domain now unavailable”, an empty search result or lack of a log entry is insufficient. An explicit HTTP 400/401/403/422 refusal may use `{"error":"...","definite_failure":true}` with the same strict meaning. A definite failure authorizes the operator's refund process.

`/prepare` must not register a domain or create a paid subscription. It receives the private contact because registration needs it. `/submit` and `/reconcile` receive a contact handle, not wallet signatures, owner authentication keys, or payment authorizations.

All prices must be all-in operator costs in USD, including applicable supplier fees and charges. Enforce `max_cost_usd` at the point of purchase or have the operator explicitly absorb a price race. Disable autorenew and optional paid extras. If a registrar cannot cap the final charge atomically, document this limitation instead of claiming atomic price protection.

## Optional endpoints

`/dns/get` receives the supplier-domain object and returns `{records,revision}`. `/dns/set` receives `{domain:SUPPLIER_DOMAIN,records,revision}` and returns the fresh snapshot. Use full DNS names in this contract. Replace only explicit `(name,type)` sets, preserve everything else, check ownership, reject stale revisions, and report non-atomic external editing limitations. Do not treat API keys sent in DNS content as instructions.

`/transfer-code` receives the supplier-domain object and returns `{auth_code,locked,note}`. Return it only after ownership verification. This result is secret and is excluded from Hub and the default MCP tool list. Registrar transfer locks still apply.

## Runnable example

[examples/supplier.mjs](examples/supplier.mjs) is a localhost simulator with HMAC verification, durable simulated orders and DNS. It is an example of the wire protocol, not a real registrar.

```sh
# Put a random 32+ character secret in a private file first.
DOMAIN_SUPPLIER_SECRET_FILE=/private/path/supplier.key node examples/supplier.mjs
```

In the operator's `.env`, use `DOMAIN_MODE=sandbox`, `DOMAIN_PROVIDER=http`, `DOMAIN_SUPPLIER_URL=http://127.0.0.1:9496` and the same secret file. It uses simulated payments. Do not expose this example as a live supplier.

Before adding a production backend, exercise registration, renewal, true refusal, lost response, process restart, wrong owner, stale DNS revision and supported TLD policy in the supplier's sandbox. The kit tests its adapter boundary using fixtures; they do not certify a third party's registrar account or implementation.

## Openprovider adapter

The availability endpoint may omit `is_premium` for ordinary names, as shown in the [official availability example](https://docs.openprovider.com/) and observed in Sandbox. The adapter permits that omission only at the availability step. Both create and renewal price responses must explicitly contain boolean `is_premium: false`; a true flag is rejected as `premium_not_supported`, a registry claim as `domain_claim_not_supported`, and missing/malformed price flags as `registrar_premium_status_unknown`. This does not disable the pre-charge price recheck or the zero premium/EAP fee limits on registration.

Implemented against the [published REST specification](https://developer.openprovider.com/data/swagger.json) and [getting-started guide](https://developer.openprovider.com/get-started.html). Production base is `/v1`; the [sandbox guide](https://support.openprovider.eu/hc/en-us/articles/8095671860114-Sandbox-Testing-Environment) currently specifies `/v1beta` on the separate sandbox host. Account capabilities, currency and registry agreements must be checked during operator onboarding.

The adapter uses contact handles belonging to the supplied registrant, standard Openprovider DNS, explicit autorenew off, and disabled paid extras. Registration reconciliation matches both its unique order comment and owner handle. Renewal reconciliation needs its durable acknowledged response or manually recorded registrar evidence plus matching ownership and increased expiry. The API does not provide an application idempotency key or an atomic normal-price ceiling here, so the kit never guesses either guarantee.

DNS names are normalized to FQDNs on read and relative labels on writes. Simple single-string TXT quotes are normalized; escaped or multi-string forms are preserved. Unchanged records are skipped and changed RRsets use add/remove/update deltas according to the [zone modification guide](https://support.openprovider.eu/hc/en-us/articles/360024342733-3-Zones-API-How-to-modify-a-zone). TTLs are constrained to that guide's supported values. The internal Sandbox pilot verified creation and modification of the test zone, relative/FQDN mapping, and preservation of an unrelated TXT record. New operators should repeat the pilot against their own account.

## Porkbun Sandbox adapter

Set `DOMAIN_PROVIDER=porkbun`, `DOMAIN_MODE=sandbox`, `PORKBUN_API_KEY_FILE` and `PORKBUN_SECRET_KEY_FILE`. See [setup, recovery and production gates](PORKBUN.md). Uses the same public capabilities with no buyer changes; transfer-code is not advertised. Unlike the HTTP bridge and Openprovider, Porkbun recovery may replay a persisted idempotent write within a 23-hour window. It never invents a new key for an ambiguous purchase.
