# Sentinel: deployment and domain

**Result:** domain, DNS, HTTPS and API checks passed; repeat charge: $0.
Website: [sentinelproof.click](https://sentinelproof.click/).
The application report has the separate ATLAS limitation described below.

## Scope

The factory had already built Sentinel and deployed it to Vercel. This pilot
redeploys that existing version, registers `sentinelproof.click` in the owner's
Porkbun account and connects it to the existing Vercel project.
Porkbun supplies the domain and DNS; Vercel continues to host the application.
This is not a fresh application build or an unattended factory pipeline test.

## Budget and credentials

Authorization covers one year of registration, capped at $3. The actual charge
was $1.54, reducing the balance from $10 to $8.46. Auto-renewal is disabled.
The quoted renewal price was $10.81; obtain a new quote before any renewal.
Registration uses the account's existing contacts and enables WHOIS privacy.
The owner must complete any required registrant email verification.

Production Porkbun keys are read from
`~/.config/domain-kit/porkbun/production/api-key` and `secret-key` with `0600`
permissions. The existing Vercel token stays on the factory server and is used
through SSH. It is not copied locally. No GitHub writes occur.

## Run from aicom

```bash
node domain-kit/scripts/sentinel-live-pilot.mjs preflight
node domain-kit/scripts/sentinel-live-pilot.mjs deploy
node domain-kit/scripts/sentinel-live-pilot.mjs run
```

Use `preflight` before the first purchase: it calls the official dry-run endpoint
without charging. After registration, the name is no longer available.
`deploy` creates one redeployment and subsequently checks that same deployment.
If it is still building, wait and run the command again.
`run` purchases only after the website and `/api/health` pass.
Repeating `run` reuses the purchase receipt and deployment, with no new purchase.
Exit code `2` means DNS or HTTPS is still pending.

After DNS setup, readiness checks run automatically with a 20-second pause
between attempts and a 10-minute waiting window; an in-flight network probe
finishes under its own timeout. Progress distinguishes DNS, certificate, HTTPS,
application and provider waits. `ready` requires verified ownership, correct
DNS, a certificate, the expected page and a healthy API/database.
Progress is saved in `data/sentinel-live/setup-status.json`.
A timeout remains pending and exits with code `2`. Resume setup without entering
the purchase path using `node domain-kit/scripts/sentinel-live-pilot.mjs verify`.
There is no background polling after process exit; a new invocation or an external
scheduler must resume it. Access errors require operator attention.

## Recovery and acceptance

Encrypted state lives in the Git-ignored `domain-kit/data/sentinel-live/`.
Never delete it to retry. An ambiguous registrar response is retried with the
original operation key. After 23 hours, stop for manual reconciliation.
`pilot.lock` prevents concurrent runs; after a crash, verify that the recorded
process has exited before removing the lock.

Acceptance requires Vercel domain verification, correct DNS, working HTTPS,
a successful API health check and zero balance change on the repeated run.
The browser safety-report scenario is recorded separately; a healthy domain
does not prove upstream data services work.

This is a pinned owner-account pilot, not a production reseller service.
The existing sandbox supplier adapter remains unchanged.

## Observed application limitation

The Berlin browser scenario on both the original Vercel URL and the new domain returned `UNKNOWN`:
the metered ATLAS capability `atlas.situation.brief@v1` was unavailable in the
current free mode. No additional ATLAS payment was made. This remains an
application-level limitation, separate from domain registration and DNS.
