# Validation record

Checked locally on 2026-10-18 with Node.js 22.22.1. This record describes local verification; it is not certification of a live registrar or payment account. The tree now lives at `domain-kit/` in the monorepo (GitHub satellite alexar76/domain-operator-kit). The runs below were recorded on the standalone checkout before that move.

| Check | Result |
|---|---|
| `npm run check` | Passed: JavaScript syntax, exported schema consistency, locked dependencies |
| `npm test` | **38 passed, 0 failed, 0 skipped** |
| `npm run demo` | Passed: signed HTTP quote → simulated registration → DNS → renewal |
| `docker compose --env-file .env.example -f compose.yaml config --no-env-resolution --quiet` | Passed: Compose configuration parses |

The HTTP and MCP tests require localhost sockets. In a restricted execution sandbox, that permission was granted for local testing; no registrar purchase or blockchain transaction was performed.

## Standalone repository verification

After extraction to a separate checkout, `npm run check`, all **38 tests**, and `npm run demo` passed again on Node.js 22.22.1. The CI workflow now runs from this repository root. README links were checked locally, and the SVG hero was rendered and visually inspected. No GitHub Actions run or remote publication is implied.

## Internal pilot — 2026-10-19

At the owner's request, the internal local phase was rerun from the standalone repository at commit `420d663`. `npm run check`, all **38 tests** (0 failures, 0 skipped), and `npm run demo` passed. The run exercised the stdio MCP subprocess, signed HTTP lifecycle, retry/restart recovery, simulated refunds, DNS and renewal. The demo returned delivered registration and renewal with a signed receipt.

This was a local simulation and automated transport test, not an Openprovider Sandbox purchase or an interactive test in a configured agent application. No domain was registered externally, no money was sent, no Vercel project was changed, and nothing was pushed.

The next phase awaits sandbox account configuration: the repository had no `.env`, and `OPENPROVIDER_USERNAME_FILE` / `OPENPROVIDER_PASSWORD_FILE` were not set in the execution environment. Only configuration presence was inspected; no secrets were displayed.

## Openprovider Sandbox connection — 2026-10-19

Using credentials stored outside the repository with file permissions `0600`, the adapter authenticated against `https://api.sandbox.openprovider.nl/v1beta/auth/login`: HTTP 200, API code 0, bearer token received. Credentials and tokens were not printed or saved in this repository. This supersedes the earlier missing-credentials blocker.

The first domain availability request returned HTTP 200 and API code 0, but the adapter rejected the result with `premium_or_claim_not_supported`. That error can also mean a missing or non-boolean `is_premium` field; it does not establish that the probe name was premium. A separate diagnostic login succeeded, but subsequent availability and create-price requests timed out. A usable domain quote is therefore not yet validated; the response contract and sandbox latency still need investigation.

Only authentication, availability and price requests were made. No contact, domain, DNS record, payment or Vercel resource was created or changed. Nothing was pushed.

## Completed Openprovider Sandbox pilot — 2026-10-19

Final local validation: `npm run check`, **44 tests passed (0 failed, 0 skipped)** and `npm run demo`. The final standalone Sandbox process rerun also passed, including changing an existing A record and reapplying identical DNS with zero additional PUTs.

This supersedes the initial connection failure above. The availability response for an ordinary name omitted `is_premium`; both operation-price responses explicitly returned `false`. The adapter now accepts the documented availability omission while requiring explicit non-premium create and renewal prices. Premium, registry-claim and unknown/malformed flag errors remain separate. Read-only transport requests retry once; mutations are never automatically replayed.

The authenticated HTTP client obtained signed Sandbox quotes for `.com`, `.net` and `.org` with the configured fixed $2 markup. Observed first-year / renewal estimates including markup were $13.98 / $18.98, $17.53 / $21.99 and $21.99 / $21.99 respectively. These are test-account observations, not published production offers or guaranteed renewal prices.

The executable `npm run sandbox:pilot` then exercised the real Openprovider Sandbox API with simulated payments and a fictional test registrant:

| Check | Evidence |
|---|---|
| Registration | One successful registrar submission; matching order comment and owner handle; active domain |
| Lost response | Successful registration response deliberately discarded; SQLite reopened and service rebuilt; same order recovered to delivered |
| Repeat registration | Separate process reruns retained the same order and domain; still exactly one registration submission |
| Owner | Registrar owner handle matched the stored buyer; an unrelated signing key was denied access |
| DNS | Test zone created by the registrar; A/TXT writes and preservation of unrelated TXT verified; quoted TXT normalized; unchanged RRsets skipped |
| Renewal | Exactly one renewal submission and an explicit registrar acknowledgement; expiry changed from 2027-10-19 to 2028-10-19 |
| Repeat renewal | Same order after restart returned delivered without another registrar renewal |
| Registrar settings | Direct domain read confirmed `ACT` and `autorenew: off` |
| MCP | A real stdio `domain-rails` subprocess read order status, domain info and DNS for the Sandbox domain |

Repeated runs exposed intermittent Sandbox timeouts and an HTTP 400 / API code 18002 during DNS operations. The kit preserves uncertain mutation outcomes. DNS now computes changes instead of deleting and re-adding unchanged records; updates use the registrar's `records.update` form. Simple quoted TXT values round-trip consistently; escaped/multi-string values retain their wire syntax.

The pilot retains its domain, encrypted order database and private keys locally under ignored `data/sandbox-pilot/`. Credentials remain outside the repository. No real domain purchase, on-chain payment, production registrar request, Vercel change or push was performed. Registration/renewal in the pilot use the signed HTTP client; the MCP check is automated transport validation, not an interactive Codex/Cursor session.

## Completed Porkbun Sandbox pilot — 2026-10-19

Second built-in registrar, using the same public capabilities. The official disposable sandbox keypair was obtained without a user-account approval flow; `/ping` confirmed `sandbox: true`. Credentials remain outside the repository in private files. The bootstrap script is also tested against controlled responses for sandbox-only behavior, permissions, no secret output and refusal to overwrite keys.

`npm run sandbox:porkbun` passed against the real Porkbun sandbox API with fictional contacts and simulated buyer payments. A repeated process run retained the same domain and purchase orders:

| Check | Evidence |
|---|---|
| Registration | One distinct Porkbun order receipt; active domain, buyer contact read back, auto-renew `0` |
| Lost registration response | Successful response discarded; service/SQLite reopened; same persisted idempotency key recovered the original receipt |
| Renewal | One distinct renewal receipt; expiry advanced exactly one year; lost response recovered after restart with no extra purchase |
| DNS | A/TXT read/write, unrelated TXT preserved, unchanged write skipped; lost create response recovered after restart with no duplicate record |
| Owner isolation | Unrelated buyer signing key rejected; registrar contact verified on management reads |
| MCP | Real stdio subprocess read status, info and DNS |
| Price | Observed `.com` supplier cost $11.08 + fixed $2 markup = $13.08; renewal also $13.08 in this test account |

The standard `configuredService` path also authenticated and quoted `.net` ($12.52 supplier cost) and `.org` ($11.84 supplier cost) without purchases. These prices are observations, not a future price promise. The sandbox permitted immediate renewal; production documentation's 30-day restriction remains a launch gate. Transient HTTP 503s occurred during reads; reads retry once, while mutations use durable reconciliation. Tests cover missing sandbox markers, wrong/live keys, premium/unknown status, unsupported terms, exact cents, changed request bodies, preview responses, mismatched purchase receipts, account changes, contact ownership, the 23-hour replay cutoff and interrupted DNS plans.

Final local checks: `npm run check`, **57 tests passed (0 failed, 0 skipped)** and `npm run demo`. State remains under ignored `data/porkbun-pilot/`. Porkbun production mode is explicitly blocked in this adapter pending production validation. No real payment, registered public domain, public DNS change, Vercel change or push occurred. Setup and limitations: [PORKBUN.md](PORKBUN.md).

## What was exercised

* Fixed markup with integer money arithmetic, invalid domains/TLDs, unavailable/premium domains, quote expiry and supplier repricing before settlement.
* Concurrent duplicate orders, changed-body idempotency conflicts, payment nonce reuse, owner isolation and stale renewal quotes, including a previously created unpaid order.
* Lost payment responses, durable restart recovery, registrar timeouts, confirmed refusal, refund limits/reservations, refund-signing failures, unknown refund outcomes and explicit operator evidence.
* Finalized Base USDC evidence: authorization/transfer matching, wrong recipient/value, canceled and expired authorizations, bounded scans and recovery cursors. RPC responses are fixtures; no mainnet RPC is needed by tests.
* Real installed x402 SDK creation of Base USDC EIP-3009 signatures, independent signature recovery, original-payer refund signing, and wallet-to-order/owner binding. Wallets are public, unfunded test fixtures; no settlement was broadcast.
* Real localhost HTTP requests, request-bound seller signatures, replay protection, daily buyer budget, and a real stdio MCP subprocess performing quote/register/status/DNS with contact supplied from a private file.
* Server startup, durable identity files, refusal of a second process, clean shutdown and restart. An independent supplier subprocess completes the authenticated HTTP contract and rejects a wrong secret.
* Openprovider REST mapping against mocked responses: USD and premium gating, buyer contact handles, paid extras/autorenew off, order-specific reconciliation, ambiguous renewals, relative DNS labels and TTL restrictions.
* Vercel API fixtures: project/team scoping, preferred recommended IPs, TXT preservation, refusal to overwrite existing routing without explicit instruction, IPv6 conflict detection and repeated-call behavior.

## Not exercised live

* Openprovider production authentication, production currency/fees, registry contracts, production domain creation, real contact/email verification and public DNS publication. Sandbox authentication, quoting, registration, DNS and renewal passed as recorded above; production operations remain untested.
* CDP settlement, funded refund reserves, real Base RPC availability and historical coverage.
* Actual Vercel project attachment, DNS propagation, TLS issuance or HTTPS reachability.
* Docker image build/runtime and the Node 24 CI matrix. Compose syntax was checked locally; the workflow has been added but not run on GitHub during this task.
* Hub publication, catalog enrollment, package publication or production deployment. No existing Factory project was modified.

These are launch gates in [OPERATIONS.md](OPERATIONS.md), not claims inferred from passing fixtures.

## Provenance

The read-only Base reconciliation implementation and its six regression tests were adapted from the eSIM operator kit before this repository was extracted. The MIT license is retained in [LICENSE](LICENSE); source attribution is in [NOTICE.md](NOTICE.md). Registrar and Vercel source references are linked in [SUPPLIERS.md](SUPPLIERS.md) and [OPERATIONS.md](OPERATIONS.md).

## Canonical monorepo migration — 2026-10-19

The Porkbun implementation from standalone commit `b4e18de` was transferred to the canonical `aicom/domain-kit/` directory, preserving the monorepo's satellite URL and packaging metadata. `npm run check --prefix domain-kit`, all **57 tests**, `npm run demo --prefix domain-kit` and the retained-state `npm run sandbox:porkbun --prefix domain-kit` passed from the monorepo. The first restricted test run could not bind localhost (`EPERM`); the complete suite passed when localhost was allowed.

Private pilot state was copied into the ignored `domain-kit/data/` directory; credentials remain outside the repository. The sandbox rerun recovered the existing domain and receipts, confirmed DNS/owner/autorenew and MCP reads, and created no additional purchase. The user subsequently deleted the sibling standalone checkout; its absence was verified. Use only `aicom/domain-kit/` for further development and pilots. This location is recorded in `AGENTS.md`. Nothing was pushed.

## Recheck after deletion of standalone checkout — 2026-10-19

Verified that the former sibling directory no longer exists. All 17 migrated files were checked against the retained original migration patch: implementation, scripts, tests and unchanged documentation match their original blob hashes; README/package metadata and this validation record retain intentional monorepo changes. The complete migration patch also passed a reverse-apply check without modifying files. All three copied private state directories are present; external credential files remain mode `0600`.

Fresh runs from `aicom/`: syntax/schema/lock check passed, **57 tests passed (0 failed, 0 skipped)**, demo passed, and **both Porkbun and Openprovider Sandbox pilots passed**. Each reused its original domain and registration/renewal orders, verified owner isolation, DNS, auto-renew disabled, restart behavior and real MCP reads. Openprovider still recorded one registration submission and one renewal submission; Porkbun still recorded one distinct receipt per purchase. No production purchase, real payment or push occurred. The working-location note is retained in [AGENTS.md](AGENTS.md).
