# Threat Model

Version: 0.1.0-alpha.0
Last updated: 2026-06-04

## Scope

This model covers the public alpha repository: Fastify API, Postgres schema, object-storage artifact boundary, React web app, CLI, stdio MCP server, HTTP MCP adapter, package parser/scanner, Docker packaging, and release workflow.

Out of scope for alpha: hosted service operations, multi-instance federation, paid support, container image publishing, and external provider login flows that are not implemented yet.

## Assumptions

- Deployments are self-hosted by operators who control Postgres, object storage, email provider, TLS, and reverse proxy configuration.
- Public alpha users may run the app locally or in a test environment.
- Alpha deployments should not be treated as business-critical systems without additional operational controls.
- Uploaded packages are untrusted until validation, scan, review, and publication gates pass.
- Alpha posture assumes closed or request-gated registration, maintainer-reviewed publication, HTTPS ingress, private object storage, and no automatic package execution.

## Assets

- User accounts, roles, sessions, MFA state, API tokens, auth action tokens, and provider mapping configuration.
- Skill metadata, lifecycle/review state, scan findings, package artifacts, object hashes, and bundle payloads.
- Audit events for auth, admin, package review, artifact delivery, and MCP authorization.
- Deployment secrets for database, object storage, email delivery, token encryption, and provider integrations.
- Release artifacts, checksums, and GitHub tag state.

## Trust Boundaries

- Browser to API over HTTP(S), using session bearer tokens.
- CLI to API over HTTP(S), using stored sessions or scoped API tokens.
- MCP clients to HTTP MCP adapter, using scoped API tokens before protocol handling.
- MCP stdio process to API, using explicit `MYSKILLS_TOKEN`.
- API to Postgres for canonical product state.
- API to object storage for package artifacts.
- Package upload boundary from untrusted author input into validation, scanning, object storage, review, and publication.
- Release boundary from clean git `HEAD` to source archive, metadata, checksums, and tag-triggered CI.

## Entry Points

- Auth, registration, email verification, password reset, MFA, session, API-token, provider-admin, user-admin, audit, search, detail, bundle, submission, and review API routes.
- Web login, admin, submission, maintainer review, and public registry UI.
- CLI login/logout, token, validate, scan, submit, review, export, install, update, and rollback commands.
- MCP `search_skills`, `get_skill_info`, and `get_install_instructions` tools.
- Package directory and `.zip` parsing.
- Docker and production environment configuration.
- GitHub release workflow and local release artifact script.

## Abuse Paths And Current Mitigations

| Threat | Impact | Alpha likelihood | Current mitigations | Remaining work |
| --- | --- | --- | --- | --- |
| Unauthorized discovery of private or unsafe skills | Metadata or package-content exposure | Medium | Server-side public/review/security/publish predicates, generic denial paths, API/CLI/MCP tests | Broader cross-surface regression matrix for future role-gated MCP/admin tools |
| Token theft or replay | Account/API misuse | Medium | Opaque hashed sessions and API tokens, scoped tokens, revocation on disable/delete/password reset, MFA-gated privileged actions, CLI platform keyring storage with user-only file fallback | Browser/device login for CLI |
| Auth brute force across restarts or replicas | Account takeover pressure and noisy abuse | Medium | Shared database-backed auth throttling before expensive auth work | Ingress throttles, alerts, and higher-volume abuse controls |
| Malicious package archive | Path traversal, unsafe install content, secret leakage | Medium | Root manifest validation, archive traversal/symlink/encryption/compression/size/file-count defenses, blocking scans, maintainer review | Background scan jobs, richer policy fixtures, deprecate/revoke workflows |
| Malicious prompt or uncommon secret passes narrow scanner | Reviewer social engineering or private-data exposure | Medium | Baseline secret/command/install-hook rules plus maintainer review | Broader fixture-backed scanner corpus and reviewer diff views |
| Artifact tampering or direct object exposure | Installing unreviewed or modified content | Medium | Internal opaque storage keys, API-owned object writes, byte-size and SHA-256 verification on read, fail-closed mismatch handling | Signed/direct delivery design with audit and authorization preserved |
| Admin/provider role escalation | Owner/admin compromise or broad mapped access | Low to medium | MFA-verified session-only provider/user/role admin, provider secrets rejected from admin API, provider mappings cannot grant owner/admin, last-owner safeguards | Full provider login/linking lifecycle and invite/account recovery policy |
| MCP bearer misuse | Agent sees unauthorized metadata or performs unsafe action | Medium | HTTP adapter validates scoped API token before MCP protocol handling, read-only tools, no bundle payload retrieval, host/origin restrictions | Per-tool authoritative audit and role-gated maintainer/admin tools |
| Audit or error leakage | Token/package/private-data exposure | Low to medium | Sanitized audit listing, generic auth responses, secret scan, no package contents in review/MCP metadata | Structured audit export hardening and operational log guidance |
| Release artifact mismatch | Public tag does not match source or package version | Low | Clean-worktree artifact script, `dist/`-only output guard, tag/version check, checksums, GitHub tag workflow | GitHub Release/container publishing policy |
| Release pipeline compromise or weak provenance | Harder to prove artifacts came from reviewed source | Low to medium | Reproducible source archive, checksums, release workflow, production Docker targets | SHA-pinned actions, digest-pinned base images, SBOM, provenance, signing, protected release tags |

## Alpha Risk Acceptance

The alpha can be public if the repo passes release checks and GitHub private vulnerability reporting is enabled. The accepted alpha risk is that operators must not rely on it for business-critical production workloads until the business-safe release goal is complete.

## Business-Safe Release Security Gates

- Per-tool MCP audit events.
- Background scan jobs and stronger package policy fixtures.
- Ingress abuse controls and alerting around auth-rate-limit pressure.
- Provider login/linking and external identity lifecycle.
- Browser/device login for CLI auth.
- Signed or direct artifact delivery design with authorization and audit.
- Release provenance with pinned actions/images, SBOMs, signatures, and protected tags.
- Private/org/team sharing authorization model before marketing non-public package sharing.
- Production logging, monitoring, backup, restore, upgrade, and incident-response runbooks.
- Final security review after production hardening work.
