# Identity and governance delivery

This record tracks ID-GOV source work separately from release and deployment.

## Device-login failure scenarios

Written before implementation. The observable boundary is the API and real CLI
with browser consent, not a mock that supplies an already-authorized token.

- Anonymous callers and API tokens cannot inspect or decide browser consent.
- An unrecognized code, expired request, denied request or used request cannot issue a token.
- Polling before the advertised interval returns slowdown and increases the interval.
- Approval and token issuance are single-use across concurrent API replicas.
- A restart preserves pending requests and polling budgets in PostgreSQL.
- Invalid scopes fail before a request is created. Consent shows the exact requested scopes.
- Privileged roles or write scopes require an actual session MFA event within 15 minutes.
- Revoked approving sessions and disabled accounts cannot redeem prior approval.
- Issued tokens remain subject to live scopes, account status and immediate revocation.
- Device codes and issued credentials stay out of browser URLs and log/audit payloads.
- A CLI denial, timeout or malformed server response cannot overwrite stored credentials.

## Scope

Implement first-party browser/device login using existing scoped API tokens,
session cookies, account locks and authentication stores. Preserve existing
password, API-key and MCP OAuth behavior. Do not add passkeys, change the auth
framework, configure an external provider, or publish a release.

## Current reconciliation

PostgreSQL auth throttling already exists in migration 0010 and is wired for
login, registration, MFA and account recovery. The existing PostgreSQL test
uses two pools and concurrent calls. Restart and API-replica evidence remains
separate from that store-level proof.

Provider configuration stores issuer/client metadata and restricted role
mappings. It does not implement provider login or linking. Before selecting a
runtime contract, decide the provider protocol, approved issuer and audience,
stable subject key, verified-email policy, explicit linking confirmation,
role/group claim semantics, deprovisioning signal and local recovery policy.
No provider account setup or paid call is required for this slice.

## Configuration and token policy

Set `MYSKILLS_DEVICE_VERIFICATION_URL` to the trusted web application's
`https://<host>/auth/device` URL to enable browser login. HTTP is accepted only
on loopback for local verification. The URL must have no credentials, query or
fragment. Keep the web origin in the existing API allowed-origin configuration.
Apply migration `0038_device_login` before enabling the service.

Run `myskills login --method browser --scopes profile:read,skills:read`. The CLI
prints the configured page and a code; the browser shows requested scopes and
requires explicit approval. Defaults are profile, skills and architecture read.
Requests expire after five minutes. Early polling adds five seconds to the
persistent interval, capped at 60 seconds. Issued tokens expire after 30 days
and use the existing token store, authorization and revocation paths. Browser
sign-in is not MCP OAuth consent. CLI logout retains the existing local-only
API-token behavior; revoke the token in account settings when required.

Write scopes and privileged account roles require a genuine session MFA event
within 15 minutes at approval and redemption. Its original timestamp is stored
on the token. Existing API-token MFA behavior after issuance is preserved;
this slice does not introduce refresh tokens or change all token assurance.

## Local candidate evidence

Supported Node 24 and the repository's npm 11.12.1 were used. These checks passed:

- API and CLI builds, web typecheck and ESLint.
- Two-instance API fixture: scopes, session-only consent, shared slowdown,
  concurrent single-use issuance, replay, denial, expiry, stale/fresh MFA,
  revoked approving session, disabled account and issued-token revocation.
- Real CLI over loopback HTTP: consent endpoints, scoped token storage, no
  credential output and denied login preserving previous credentials.
- Chromium browser fixture: exact scope review, failed approval retained,
  explicit denial, no code in URL and attached screenshot. API responses mocked.
- Capability inventory and generated matrix checks.

Repeat with `node --import tsx --test apps/api/test/device-login.e2e.test.ts
apps/api/test/device-login-cli.e2e.test.ts` and
`npx playwright test device-login.spec.ts --config apps/web/playwright.config.ts`.
The PostgreSQL journey is included in `npm run test:postgres` and must use a
disposable test database. Local fixtures do not establish PostgreSQL, live
provider, deployed, release or real MCP-host acceptance.

## Integrated PostgreSQL proof preparation

The integrated store refreshes application time after acquiring account, session
and request locks. Grant/session expiry and MFA freshness are checked at this
decision point. PostgreSQL transaction-start `now()` does not enforce deadlines
that pass during a lock wait. The store's injected clock supports deterministic
tests while production uses the current clock.

`postgres-device-login-atomicity.pgtest.ts` is discovered by the existing canonical
`test:postgres` command. It uses separate database pools and observed lock waits,
not a memory fixture, to prepare proof for admission limits, duplicate codes,
concurrent consent/redemption, exact scopes, replay, both revocation lock orders,
and grant/session/MFA expiry during waits. A failure trigger after token insertion
checks rollback of issuance, consumption, polling state and redemption audit.
These PostgreSQL tests are prepared but not executed on Mini. The parent owns the
canonical Windows run. Local Node 22.23.2 checks cover source builds and the memory
API journey; they do not substitute for database execution.

The CLI now rejects redirects on anonymous start/poll requests and consumes at
most 16 KiB of response bytes with strict UTF-8 decoding. Two-origin and streamed
negative fixtures cover credential preservation and prevent forwarding the
redeemable device code.
