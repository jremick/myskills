# Changelog

All notable user-facing changes will be tracked here. MySkills is still prerelease software; breaking changes may happen between beta releases and will be called out in this file.

## Unreleased

### Changed

- Updated AWS SDK, Nodemailer, Resend, Zod, React Flow, and Lucide dependencies.

## 0.1.0-beta.5 - 2026-09-05

Target release: `v0.1.0-beta.5`.

This operational release completes registry feedback and recovery paths, hardens
local and managed updates, and adds immutable deployment and registry identity.
Verification and Railway promotion are tracked in
[Operational Beta Delivery](docs/OPERATIONAL_BETA_DELIVERY.md).

### Added

- Added strict SemVer release metadata, compatibility constraints, update
  discovery, dry-run planning, and release-note review across the API, CLI,
  and web registry.
- Added transactional local CLI install, update, and rollback with verified
  artifacts, atomic registry changes, retained snapshots, drift detection, and
  deterministic recovery after an interrupted filesystem transaction.
- Added consent-gated contract-v2 companion operations for connected targets.
  Exact install, update, and rollback plans use idempotency keys, leases,
  fencing tokens, generation checks, sanitized receipts, and reclaimable
  expired claims.
- Added the in-app system update centre with target inventory, individual and
  batch review, queue and cancel controls, operation status, failed-operation
  recovery evidence, rollback, and immutable architecture revision promotion.
- Added immutable target and organization upgrade-policy revisions with stable
  or prerelease channels, exact pins, allowed change types, and optional
  maintenance-window execution.
- Added author review feedback, historical release and archived-skill management,
  explicit package-file inspection, stable direct links, and registry pagination.
- Added personal Codex workspace enrollment, filesystem observations, and an
  explicit companion command for queued updates and verified rollback.
- Added embedded API/web build identity, stable registry identity, and executable
  operational acceptance and database-plus-artifact recovery tooling.

### Security

- Target mutation requires explicit consent, the contract-v2 `apply` or
  `rollback` capability plus `sync.write`, and an API token with the dedicated
  `targets:execute` scope. Stale generations, claims, fences, observations,
  policy revisions, and artifact plans fail closed.
- Queue state and audit commit together. Batches are atomic, completed retries
  return their original operation, and bounded polling progresses past blockers.
- Admin status, roles, token revocation, registration settings, and provider
  changes roll back when their audit write fails. Artifact publication and
  cleanup coordinate through durable write intents and bounded storage requests.
- Package intake holds one bounded byte snapshot. Local installs retain unknown
  edits during recovery and reject unsafe payload paths. Production dependency
  updates address the fast-uri and qs advisories.

### Compatibility changes

- Existing local installations without a registry identity require review and a
  fresh install root; automatic adoption is disabled. Preserve the old files.
- Local package intake and filesystem writes require macOS or Linux. Native
  Windows is unsupported; portable API buffer uploads remain available.
- Keyring failures are reported instead of silently writing a fallback file.
  Select file storage explicitly when required. New passwords must fit within
  bcrypt's 72-byte UTF-8 limit; legacy password verification remains compatible.
- A fresh Codex workspace creates its own personal target. Existing target IDs
  cannot bind a second workspace. Full architecture graph execution, background
  agents, and additional provider adapters remain outside this beta.

## 0.1.0-beta.4 - 2026-09-02

Target release: `v0.1.0-beta.4`.

This security fix-forward release supersedes beta.3 without changing the Phase 2
API, CLI, or MCP contracts.

### Security

- Removed two file-system time-of-check/time-of-use races in the read-only Codex
  target adapter. Metadata and skill frontmatter are now opened once without
  following the final symlink, validated through the same file descriptor, and
  read through bounded descriptor operations.
- Updated the transitive `browserslist` development dependency to the patched
  line after new high-severity availability and malformed-stats advisories were
  published.

### Release

- Verified the exact published CLI version before checking the mutable npm
  `beta` channel, and used an isolated cache for the channel install check so
  registry propagation cannot be misclassified as incorrect package bytes.

## 0.1.0-beta.3 - 2026-09-01

Target release: `v0.1.0-beta.3`.

This release adds the Phase 2 architecture control plane. It does not claim a
hosted Phase 2 deployment; Railway promotion remains a separate production
operation with its own backup, migration, readiness, and rollback gate.

### Added

- Added immutable skill architecture shells and revisions with `flat`,
  `domain-router`, and `multi-level-router` patterns; exact release digests;
  deterministic profile/environment compilation; and accessible
  JSON/Mermaid/plain-outline diagram projections through the API, web, CLI,
  and read-only MCP surfaces. API/web/CLI also expose explicit
  fixture-backed dry-run planning.
- Added user/team architecture tenancy, effective organization-parented team
  membership checks, organization policy revisions, and policy-bound
  architecture sharing. Manager-only GET/PUT organization-grant routes use
  atomic replacement, current-revision concurrency checks, and audited
  revoke/save behavior; the web workbench exposes the same controls.
- Added connected architecture-target metadata, consent, health, generation,
  capability, and append-only observation foundations, plus organization and
  target web workbenches. The read-only Codex adapter is explicit-root and
  metadata-only; it is not a live connector.
- Added fixture-only sync-control state, leases, fencing, baselines, receipts,
  recovery evidence, and persisted Postgres plus synthetic service/executor
  test coverage for recovery and rollback. Each bounded run allows at most 500
  steps and 2,004 append-only receipts: a 1,002-receipt max-step lifecycle,
  one full apply/verify retry, and two recovery/terminal receipts. Further
  retries require a new bounded run. No target write, package installer, or
  live apply/rollback path is enabled.
- Added derive-shell pattern migration contracts, migration 0020 lineage,
  atomic Postgres shell/revision/lineage creation, preview/create routes, and
  web controls. The source architecture, grants, and target bindings are not
  copied.

### Changed

- **Breaking security change:** team
  creation, team-owner invitation/member lifecycle mutations, organization
  creation/invitation/member/policy/lifecycle mutations, and sharing changes
  that expand team or organization access now require an interactive
  MFA-verified session. The canonical sharing route and the deprecated beta.2
  `skills edit --visibility` compatibility alias are session-only; API tokens
  remain suitable for scoped reads but cannot widen sharing or perform these
  mutations. Before moving from beta.2, enroll TOTP
  MFA with `POST /v1/auth/mfa/totp/enroll` and
  `POST /v1/auth/mfa/totp/confirm`, retain the recovery codes, then use
  `myskills login` to complete the MFA challenge. Migrate mutation automation
  to an explicitly managed session or keep it read-only; do not bypass this
  boundary with a bearer token. Invitation acceptance remains session-only
  where its route permits it.
- **Breaking MCP contract change:**
  `get_install_instructions` no longer returns `apiBundleEndpoint`, a bundle
  URL, or package bytes. Consumers must use its authorized release metadata and
  generated `myskills install ...` or `myskills export ... --output ...`
  command, or use the separately authenticated API/CLI delivery path. MCP API
  base URLs now accept only absolute `http://` or `https://` URLs without
  credentials, query strings, or fragments; bearer credentials stay in
  headers. The API-owned `/v1/mcp/session` check accepts either `skills:read`
  or `architectures:read`; registry tools require the former and architecture
  projection tools require the latter. Update clients when moving from beta.2
  to beta.3.
- Added complete-set organization grant handling to canonical `myskills
  sharing set`. Omitting organization IDs preserves the beta.2 compatibility
  merge; `--clear-organizations` sends `organizationIds: []` and is mutually
  exclusive with organization IDs.
- **Deprecated beta compatibility:** generic metadata `visibility` and
  `myskills skills edit --visibility` remain supported as compatibility shims
  for beta.2 clients. They preserve omitted team, user, and organization
  grants and remain subject to the API's sharing security boundary: both
  paths require a session, and the metadata alias requires an MFA-verified
  session before it reads or replaces grants. API tokens cannot widen a skill
  through the alias. Use canonical `myskills sharing set` for new clients;
  the deprecated alias does not provide complete-set organization controls.
- The beta.2 compatibility shims remain in beta.3 and are planned for removal
  only at a later, separately published prerelease boundary with migration
  guidance and release verification. The Phase 1 Railway baseline must still
  be read back separately; source release evidence does not establish that
  Phase 2 is deployed.

### Security

- Replaced numeric Fastify proxy-hop trust with explicit proxy IP/CIDR allowlists so direct clients cannot spoof forwarded request metadata.
- Architecture projections use server-authorized exact release metadata,
  scoped reads, bounded concurrency, and fail-closed exposure and digest
  checks. Organization projections require current policy/membership/grant
  context and exclude private, team-scoped, and explicit-user release
  references.
- Organization-grant replacement locks the architecture/current revision in
  the Postgres adapter, rechecks organization policy and exact release rows,
  and records only sanitized bounded audit details. Pattern migration locks
  the source architecture and persists the new shell, first revision, and
  lineage atomically; an external release-authorizer preflight remains a
  documented residual race.
- Target observations and Codex adapter output are bounded metadata only;
  credentials, prompts, package content, paths, URLs, and raw configuration
  are excluded. Mutation capabilities remain false or absent.

## 0.1.0-beta.2 - 2026-07-13

Target release: `v0.1.0-beta.2`.

- Made the documented root `.env` path automatic for local migration, seed, API, web, and MCP development commands while keeping production starts on injected environment variables.
- Restricted supported development and CLI runtimes to Node 22/24 LTS, pinned the repo npm version in CI, added ESLint plus an explicit web typecheck gate, and isolated dependency major updates from routine Dependabot groups.
- Removed the private skill-package runtime dependency from the public CLI manifest and added an exact tarball allowlist plus a clean temporary pack/install/version/validate/scan smoke.
- Strengthened prerelease coherence checks across workspace versions, API capabilities, changelog/tag/npm channel, public dependency publishability, required docs/links, and stale maturity language.
- Added one canonical release candidate gate with tag/main ancestry verification, staging/user-test and approval boundaries, and source/npm/Railway/database/artifact rollback guidance.
- Reconciled getting-started, compatibility, API/MCP/CLI, architecture, data model, deployment, Railway, roadmap, and beta acceptance docs around implemented, live-readback, and planned state.

### Added

- Added a production-like browser gate that builds the deployed API/web images and proves nginx proxying, Postgres migrations/seed, S3-compatible storage readiness, anonymous browse, HttpOnly-cookie login, authenticated export, and logout.
- Added dependency-aware `/ready` checks, durable artifact-write recovery intents, periodic orphan reconciliation, migration serialization, and one-artifact-per-version enforcement.
- Added responsive 320/375/390 px browser coverage, URL-backed registry state, history navigation, explicit not-found/loading states, focus-managed confirmations, and accessible mobile overflow navigation.
- Added reviewer artifact downloads with an approval hash so maintainers approve the exact package payload they inspected.
- Added Chromium browser E2E coverage for cookie-backed web login and localStorage token avoidance.
- Added Postgres coverage for review bundle hashes, approval hash mismatch failures, and legacy approved-row backfill.
- Added production preflight coverage for supported `TRUST_PROXY` values.
- Added MFA-gated owner invitations and a public invitation-registration page, with Mailpit-backed full-stack proof that the emailed fragment token is scrubbed before account creation and login.

### Changed

- Destructive review, lifecycle, account, token, and admin role/status actions now use explicit confirmations; user disable/delete and role changes require an audit reason.
- Registry and public navigation use semantic links with shareable deep URLs, while privileged lifecycle/sharing controls stay visibly locked until MFA is verified.
- Browser auth now uses token-free login/MFA responses plus an HttpOnly `myskills_session` cookie for web sessions; CLI/API-token/MCP flows continue to use bearer credentials.
- Review artifact downloads now save the same compact JSON payload bytes that the approval hash represents.
- The release workflow now runs Playwright browser E2E and Postgres integration tests before release artifact creation.
- Production web builds use same-origin `/api` routing to match the nginx CSP and deployment docs.
- CI and release verification now build the exact API and web Dockerfiles used by Railway as part of the required candidate evidence.
- Railway promotion and rollback now deploy API first, verify readiness, and then deploy web from the same commit so the web proxy cannot retain a retiring API address.

### Fixed

- Restored anonymous access to the approved public registry and normalized unauthorized role-gated deep links without rendering privileged workspaces.
- Made password reset, password change, confirmed email change, MFA removal, credential revocation, last-owner enforcement, admin role transitions, and deny-audit persistence atomic under concurrent Postgres requests.
- Required revoked-release restoration to be MFA-verified, privileged, and backed by the approved artifact plus a successful scan.
- Aligned nginx with the API's bounded 14 MiB submission envelope and made container healthchecks use `/ready`.
- Backfilled approved unpublished submissions with their reviewed artifact hash during migration so existing review rows can still be published.
- Blocked review publication after an approved unpublished release is deleted or archived.
- Exposed the review artifact hash header to allowed cross-origin browser clients.
- Added production proxy trust configuration and validation so auth rate limits use client IPs behind the deployed proxy.
- Added review-queue and artifact/scan join indexes for Postgres review workflows.

### Security

- Added an API-wide shared request limiter, bounded auth parsers and rate-limit cleanup, route-specific submission limits, and allowed-Origin enforcement for cookie-authenticated mutations.
- Removed the production Compose API host port so numeric proxy trust cannot be bypassed through a shorter direct ingress path; browser and authenticated API traffic now enters through the web reverse proxy only.
- Hardened the public MCP HTTP boundary with per-IP rate limits, safe proxy opt-in, bounded headers/bodies/connections, finite downstream and upstream timeouts, abort propagation, and deterministic resource cleanup.
- Removed broad regular-expression and script file-race findings, kept bearer tokens hash-only at rest, and added executable invariants around the narrow CodeQL central-rate-limit waiver.

## 0.1.0-beta.1 - 2026-06-30

### Fixed

- Updated hosted web, support, security, and contribution copy from public-alpha wording to public-beta wording while keeping hosted signups owner-gated.

## 0.1.0-beta.0 - 2026-06-30

### Added

- Public beta readiness docs for support, contribution, compatibility, and upgrade expectations.
- GitHub issue and pull request templates for public triage.
- Dependabot configuration for npm, GitHub Actions, and Docker manifests.
- Refreshed beta web console UI and design-system components.

### Fixed

- Demo seed data now publishes and repairs `release-notes-helper@0.1.0` so it is visible through public registry reads after `db:seed`.
- SMTP auth notifications disable Nodemailer file and URL access for generated messages.

### Security

- Updated Nodemailer to the patched `9.0.1` line.

## 0.1.0-alpha.3

### Added

- Published the `@jarel/myskills` CLI alpha package with local-first API URL config, keyring-backed credential storage, auth status, doctor diagnostics, and registry workflow commands.

## 0.1.0-alpha.0

### Added

- Initial public alpha repository with API, web, CLI, MCP, package validation/scanning, Postgres migrations, Docker Compose dependencies, release artifact generation, and a public-safe example skill package.
