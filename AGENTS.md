# Domain kit working location

- Canonical source is `domain-kit/` inside the `aicom` monorepo.
- On 2026-10-19 the user deleted the former sibling checkout at `/Users/alex/Desktop/ai_tests/aicompany/domain-kit`. Do not use or recreate it as a working copy. Local work belongs in `/Users/alex/Desktop/ai_tests/aicompany/aicom/domain-kit`.
- The validated Porkbun adapter was migrated in monorepo commit `ebcb1dca1`. Preserve the monorepo and satellite metadata when editing this package.
- From the monorepo root, run package commands with `--prefix domain-kit`: `npm run check`, `npm test`, `npm run demo`, `npm run sandbox:porkbun` or `npm run sandbox:pilot`.
- Sandbox pilot state is retained under ignored `domain-kit/data/`. Reuse existing state and orders; do not discard it to work around an uncertain result. Credentials stay outside Git under `~/.config/domain-kit/`; never print their values.
- Porkbun's working disposable test credentials are in `~/.config/domain-kit/porkbun/temporary-sandbox/`. The original user-supplied key in `porkbun/sandbox/` did not authenticate and is not the validated pair.
- Keep work local: the user's standing instruction is not to push. Production purchases and real payments need a separately agreed domain and spending limit.
