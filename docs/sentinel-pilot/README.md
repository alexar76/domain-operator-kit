# Sentinel: owner-account domain pilot

Local documentation for the `alexar76` ecosystem in `aicom`. No GitHub publishing.

- [Русский](ru.md)
- [English](en.md)
- [Español](es.md)
- [Français](fr.md)
- [简体中文](zh.md)
- [English article draft for DEV.to](../../../../PromoMaterials/devto/sentinel-domain-pilot/article.md) — primary publication draft, not published

Test date: 2026-10-20 (Europe/Moscow).

**Infrastructure test passed:** [sentinelproof.click](https://sentinelproof.click/)
serves Sentinel over verified HTTPS; `/api/health` returns 200 with application
and database status `ok`. Registration cost $1.54; remaining balance $8.46.
The repeat run charged $0. Auto-renewal is off. All 66 package tests passed.
The separate safety-report scenario returned `UNKNOWN` because paid ATLAS access
is unavailable; this application limitation remains unresolved.

This pilot redeploys an existing factory-built application, then registers and
connects its domain. It is not a new application build or an unattended factory
pipeline demonstration. The production supplier/reseller adapter remains disabled;
the pilot uses the account owner's existing Porkbun balance and contacts.

Current machine-readable execution evidence is stored privately in
`../../data/sentinel-live/latest-result.json`. It must not be published wholesale.
See [result.json](result.json) for the sanitized final outcome.

## Implementation

- `../../scripts/sentinel-live-pilot.mjs`: pinned project, direct Vercel redeploy,
  registration, DNS, HTTPS and API checks.
- `../../src/owner-pilot.js`: owner registration, $3 ceiling, encrypted durable
  write receipts and bounded retries.
- `../../test/owner-pilot.test.js`: budget, lost response, expired retry window,
  account binding, DNS preservation and repeat behavior.
- `../../src/setup-readiness.js`: automatic post-purchase DNS/certificate/HTTPS/API
  readiness polling, persisted progress, resumable timeout and no purchase callbacks.
- `../../test/setup-readiness.test.js`: propagation delays, timeout/resume,
  application health and provider-error behavior.

After the original live pilot, automatic readiness waiting was added and tested.
It pauses 20 seconds between attempts for a 10-minute window, then exits pending
if necessary. `verify` resumes setup without entering registration. It is not a
background service: an exited process must be invoked again.

The pre-existing sandbox supplier and public seller API are unchanged.
