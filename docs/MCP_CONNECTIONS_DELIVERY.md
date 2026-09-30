# Remote MCP connections for ChatGPT and Claude

The [capability parity matrix](CAPABILITY_PARITY.md) is the current coverage
record, with the UI baseline and API → CLI → MCP delivery order. Current local
implementation evidence is maintained in the
[parity implementation ledger](CAPABILITY_PARITY_IMPLEMENTATION.md).

## Parity expansion after the initial build

Source now contains a fixed named-action policy, 31 application scopes shared
by API tokens and OAuth, live user/resource policy checks and actual-session
OAuth MFA provenance with a 15-minute privileged window that refresh cannot
extend. Old grants gain no new authority. Privileged account secrets and local
producer/executor actions remain trusted-control handoffs; guidance is not
execution or confirmed completion.

The API prerequisite suite passed 458 tests, including four delegated-action
and two assurance journeys. CLI slices and their distinct proof boundaries
are listed in the implementation ledger. The MCP suite passed 97 tests before final annotation/text polish, followed
by a build and two targeted checks. It covers a real OAuth SDK/API write
journey and separate transport-contract fixtures; it does not exhaustively
prove all 168 named actions. Eight handoff tests cover 27 guidance actions.
Web consent has mocked browser/component evidence. Phase-1 repository,
PostgreSQL, full-stack, merge and Railway staging evidence is recorded in
[Beta.18 release preparation](BETA18_RELEASE_DELIVERY.md#phase-1-staging-evidence).
The final Collections candidate passed the Node 22/24 repository, PostgreSQL,
browser, image and CodeQL gates and merged in PR #124. See its
[verification record](BETA18_RELEASE_DELIVERY.md#collections-and-groups-verification).
Collections staging and real ChatGPT/Claude acceptance remain pending.

The sections below preserve the **initial read-only connector build** and its
historical test results. Their two-scope policy and tool counts describe that
build only; they are not the current action policy or proof of the expanded
surface. Do not reuse its source manifest as evidence for later changes.

## Initial read-only connector record

Date: 2026-09-29
Initial build status: source implementation complete on `codex/mcp-chatgpt-claude`; not
committed, released or deployed. No ChatGPT or Claude acceptance performed.
Base: `3ab55b5da86bef5e3f6864657445b9f0ba38288d`

This record covers an opt-in OAuth connection between a MySkills account and a
remote MCP host such as ChatGPT or Claude. It separates four kinds of evidence:
source implementation, local automated checks, a deployed service, and actual
provider acceptance. Only the first two exist. Operator and user guidance is in
[Remote MCP connections](MCP_CONNECTIONS.md).

## Scope and decisions

- **Off by default.** `MYSKILLS_OAUTH_ENABLED` must be `true`, and the API
  refuses to start when the issuer, MCP public URL, consent origin or a client
  registration path is missing or unsafe. The MCP HTTP adapter requires both
  `MYSKILLS_OAUTH_ISSUER` and `MYSKILLS_MCP_PUBLIC_URL`, or neither, and its
  public path must equal its served path.
- **Public URLs come only from configuration.** Metadata, redirects, challenges
  and account guidance never use `Host` or forwarded headers. Plain HTTP is
  accepted only on loopback test stacks; the production preflight rejects it.
- **MySkills is the authorization server.** No third-party identity service and
  no new dependency. Tokens, codes, client secrets and consent handles use Node
  `crypto` and are stored only as SHA-256 digests.
- **Registration.** RFC 7591 dynamic registration, restricted to
  `MYSKILLS_OAUTH_REDIRECT_HOSTS`, and/or operator-configured clients in
  `MYSKILLS_OAUTH_CLIENTS` (secret digests only). CIMD and RFC 7592 are not
  implemented, and metadata says `client_id_metadata_document_supported: false`.
- **Protocol subset.** Authorization code with S256 PKCE only, exact redirect
  matching, verbatim `state`, RFC 9207 `iss`, RFC 8707 resource binding to the
  one configured MCP URL, refresh rotation with reuse detection, RFC 7009
  revocation. No OpenID Connect. This is a documented compatibility subset,
  not a full MCP authorization conformance claim.
- **Scopes.** `skills:read` and `architectures:read`. Connector contexts carry
  no owner, admin or maintainer role and are never MFA-verified.
- **Narrow token use.** Connector access tokens are accepted only on the read
  routes the MCP adapter uses (`OAUTH_CONNECTOR_ROUTES`). The global request
  hook applies this to the effective credential, including the decoded session
  cookie; a connector token carried in a cookie is refused on every route.
- **Tools.** Connector sessions see the eight read tools, including the new
  `read_skill_file`; `curate_bundle` is omitted. API-token and stdio clients
  keep every previous tool and also gain `read_skill_file` (nine tools). Native
  Skills methods are unchanged. Nothing installs or executes skills.
- **Consent.** The consent page shows the client name, whether it is
  self-registered or operator-configured, the redirect origin, each scope and
  the signed-in account. Accounts with MFA enabled and privileged roles must
  approve from an MFA-verified session. The handle arrives in the URL
  fragment, moves to tab-scoped storage, and the only post-sign-in return target
  is the fixed consent path.
- **Topology.** The production nginx template routes
  `/.well-known/oauth-authorization-server` and `/oauth/*` to the API, and
  `/.well-known/oauth-protected-resource*` and `/mcp` to `MCP_PROXY_TARGET`,
  so one public origin serves discovery, consent and MCP.

## Review-driven changes during the build

Parent review during the build found and this build resolved:

1. Code redemption was two transitions; a parallel replay could leave zero
   winners. Redemption is now one atomic store operation.
2. The per-account connection cap was checked only at consent; it is enforced
   again at redemption, under the account lock.
3. Account-level revocation now also revokes approved, unredeemed codes.
4. Lock order: redemption and consent decisions lock the account row before
   code or request rows, and account revocation locks the account first, so
   they cannot deadlock. Consent rechecks the approving session and account
   inside that transaction, so an overlapping account change cannot be
   followed by new code authority from the old session.
5. The connector-token guard now uses the effective credential (header or
   decoded cookie); `improvements` scope checks and `authFailureReply` treat
   every non-session credential as scoped.
6. The guard's bearer parsing now mirrors `AuthService` whitespace handling
   (0x09-0x0d and 0x20), closing percent-encoded whitespace cookie variants.
7. Consent CSS specificity and spacing; the runbook no longer prints secrets.

## Acceptance and failure matrix

Legend: **API** = `apps/api/test/oauth-connector-routes.test.ts`,
**E2E** = `apps/mcp/test/oauth-connector.e2e.test.ts` (real sockets: API + MCP
HTTP + MCP SDK client), **PG** = `apps/api/test/postgres-oauth-connector.pgtest.ts`,
**WEB** = `apps/web/test/remote-connections.test.tsx` and
`apps/web/test/e2e/remote-connections.spec.ts`, **FULL** =
`apps/web/test/e2e/fullstack/mcp-oauth-connector.spec.ts` through the production
nginx template, **ROUTE** = `scripts/check-mcp-oauth-routing.mjs`,
**PRE** = `apps/api/test/production-env-script.test.ts`.

| # | Case | Proof |
| --- | --- | --- |
| 1 | Disabled by default: routes absent, legacy MCP unchanged | API, E2E |
| 2 | Incomplete or unsafe config fails closed (API, MCP, preflight) | API, E2E, PRE |
| 3 | Discovery metadata from configuration only | API, E2E, FULL, ROUTE |
| 4 | Same-origin `WWW-Authenticate` challenge | E2E, FULL, ROUTE |
| 5 | Unknown client or redirect never redirected to | API, ROUTE |
| 6 | Protocol errors return `state` and `iss` to the registered URI | API |
| 7 | Consent requires a session; sign-in and MFA return | API, WEB, FULL |
| 8 | MFA-enabled or privileged approval needs MFA-verified session | API, WEB |
| 9 | Cookie consent requires an allowed Origin | API |
| 10 | Deny and cancel return `access_denied` | API, WEB |
| 11 | Expired and reused requests | API, WEB |
| 12 | Code replay revokes the resulting connection | API, E2E, PG |
| 13 | Verifier, client, redirect and resource binding | API |
| 14 | Confidential client authentication | API, PG |
| 15 | Refresh rotation, reuse detection, downscoping | API, E2E, PG |
| 16 | Concurrent single use (decision, code, refresh) | PG |
| 17 | Access expiry and per-call account checks | API, E2E |
| 18 | Revocation: RFC 7009, Settings, account events, unredeemed codes | API, E2E, PG, WEB, FULL |
| 19 | Two users and private skill isolation with verified content | E2E |
| 20 | Connector token refused off the MCP read path, including cookie and encoded-whitespace cookie forms | API, FULL |
| 21 | Scope enforcement | API, E2E |
| 22 | Legacy stdio and API-token clients | E2E, existing MCP suites |
| 23 | Bounds and caps (bodies, parameters, rates, connections, DCR capacity) | API, PG |
| 24 | Digests only at rest; no secrets in audit | API, PG |
| 25 | Persistence across a new store instance | PG |
| 26 | Account revocation overlapping consent and redemption, bounded, no deadlock | PG |
| 27 | Reverse-proxy routing and public URL consistency | FULL, ROUTE |
| 28 | UI: setup guidance only for a configured URL, consent content, revocation | WEB, FULL |

## Evidence

Codex independently reviewed the implementation and ran the checks below on
2026-09-29. Opus implemented through Claude Code on the personal subscription:
`claude-opus-5-5`, `xhigh`. The transcript's model fields and the attached
session's effort display confirmed those settings. No Gateway route was used.

Local checks used Node 22.23.2. Container verification used the main Windows
host with Node 24.20.0, npm 11.12.1, PostgreSQL 17 and Chromium. No containers
ran on the Mac. All fixtures used synthetic accounts and credentials.

| Check | Result |
| --- | --- |
| `npm run check` | Passed: structure, privacy, secret scan, production dependency audit, lint, builds, web typecheck, prerelease/CLI package checks and 1,238 tests; zero failures or skips |
| `npm run test:tooling` after the final harness change | 43 passed, including its three new phase-selection tests; final lint also passed |
| `TEST_DATABASE_URL=... npm run test:postgres` | Complete disposable-database suite: 244 passed, zero failures or skips; includes OAuth persistence, token concurrency, revocation and account lock ordering |
| `npm run test:e2e -w @myskills-app/web -- remote-connections.spec.ts` | Six passed on the final UI, including sign-in/MFA return, errors, setup and revocation at desktop/mobile widths; saved screenshots inspected |
| `npm run test:e2e:fullstack` | Passed both fresh-stack phases: eight existing journeys and one connector journey; zero failures, skips or flaky tests |
| Production nginx routing probes | All six passed in each full-stack phase: authorization metadata, resource metadata, MCP challenge, authorization, token and consent routes |
| Source identity | All 654 transferred files matched the source manifest; the original checkout stayed clean |

The connector full-stack journey used real nginx, API, MCP and Postgres
services. It completed browser login and MFA, consent, authorization-code
exchange, MCP tool listing/search, account connection listing, revocation,
and rejection of revoked access and refresh tokens. Its provider callback
was intercepted locally; no real provider was contacted.

The tested archive's SHA-256 is
`f89d18164369ccbf61f15b154ecf2ad1d3375fd2156ba2c50877aa5949a404bb`.
Only this evidence document was updated after that snapshot. Command logs,
source manifests, JSON reports and screenshots are retained in the private
verification record. Browser artifacts are repeatable through the commands
above; full-stack reports live under `apps/web/test-results/`.

The first combined full-stack run passed eight existing journeys but reached
the production login limit before the connector's MFA step. The harness now
runs the existing journeys and connector journey on separate disposable
stacks, with separate reports. The production limiter is unchanged. The final
default command passed both phases. Earlier failed and final passing logs are
retained.

Tests for OAuth, MCP, browser behavior, preflight and harness phases preceded
their implementation. The routing-checker's tooling test was written after
its script, an exception to the requested test-first workflow.

## Remaining gates

- Phase-1 staging and final Collections source verification are recorded above.
  The Collections revision still needs staging deployment and acceptance. Follow the
  [runbook](MCP_CONNECTIONS.md#railway-runbook) before production promotion.
- Provider acceptance requires a publicly reachable HTTPS deployment. Claude
  connectors are brokered from Anthropic's cloud, so a local or private
  endpoint cannot pass.
  - ChatGPT: record the plan and workspace settings, the registration path
    actually used (dynamic or configured), the exact redirect URI shown in its
    connector settings, authorization, and at least one tool call.
  - Claude: Customize > Connectors > Add custom connector with the remote URL,
    optional client ID and secret, authorization, and at least one tool call.
    Team and Enterprise owners add the connector; each member then connects.
- Known limits: per-address MCP rate limits see shared provider egress
  addresses; strict refresh rotation means a lost refresh response requires
  reconnecting; no CIMD; no audit event per MCP tool call beyond the existing
  session and artifact audits.
