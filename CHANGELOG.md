# Changelog

All notable user-facing changes will be tracked here. MySkills is still prerelease software; breaking changes may happen between beta releases and will be called out in this file.

## Unreleased

### Security

- Replaced numeric Fastify proxy-hop trust with explicit proxy IP/CIDR allowlists so direct clients cannot spoof forwarded request metadata.

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
