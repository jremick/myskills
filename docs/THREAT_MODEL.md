# Threat Model

Version: 0.1.0-beta.2
Last updated: 2026-08-30

## Scope

This model covers the public beta repository: Fastify API, Postgres schema, object-storage artifact boundary, React web app, CLI, stdio MCP server, HTTP MCP adapter, package parser/scanner, Docker packaging, release workflow, and the MVE Skill Architecture Control Plane (versioned graph, consolidated preview projections, and fixture-only sync planner).

Out of scope for beta and this MVE: hosted-service guarantees, multi-instance federation, paid support, container image publishing, live target adapters or apply/rollback, team-owned architecture records, organization tenancy, and external provider login flows that are not implemented yet.

## Assumptions

- Deployments are self-hosted by operators who control Postgres, object storage, email provider, TLS, and reverse proxy configuration.
- Public beta users may run the app locally, self-host experimentally, or evaluate the documented API/web/CLI/MCP surfaces.
- Beta deployments should not be treated as business-critical systems without additional operational controls.
- Uploaded packages are untrusted until validation, scan, review, and publication gates pass.
- Beta posture assumes closed or request-gated registration, maintainer-reviewed publication, HTTPS ingress, private object storage, and no automatic package execution.

## Assets

- User accounts, roles, sessions, MFA state, API tokens, auth action tokens, and provider mapping configuration.
- Skill metadata, lifecycle/review state, scan findings, package artifacts, object hashes, and bundle payloads.
- Architecture specs and immutable revisions, exact release references, profile
  exposure rules, derived diagrams, and fixture sync-plan results.
- Audit events for auth, admin, package review, artifact delivery, and MCP authorization.
- Deployment secrets for database, object storage, email delivery, token encryption, and provider integrations.
- Release artifacts, checksums, and GitHub tag state.

## Trust Boundaries

- Browser to API over HTTP(S), using token-free login/MFA responses plus an HttpOnly SameSite `myskills_session` cookie that the API maps to server-side session authentication.
- CLI to API over HTTP(S), using stored bearer sessions or scoped API tokens.
- MCP clients to HTTP MCP adapter, using scoped API tokens before protocol handling.
- MCP stdio process to API, using explicit `MYSKILLS_TOKEN`.
- API to Postgres for canonical product state.
- API to object storage for package artifacts.
- API architecture compiler/renderer to the bounded, potentially
  user-authored architecture spec and observed fixture boundary.
- Local managed-registry detector to the bounded target-observation boundary;
  install roots and skill paths remain local and are not reported to the API.
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
- Architecture list/detail/revision/preview routes and their web or
  read-only client projections when exposed by capability discovery. A
  fixture-backed dry run is submitted through the consolidated preview route;
  there is no separate target or dry-run API route in this MVE.

## Abuse Paths And Current Mitigations

| Threat | Impact | Beta likelihood | Current mitigations | Remaining work |
| --- | --- | --- | --- | --- |
| Unauthorized discovery of private or unsafe skills | Metadata or package-content exposure | Medium | Server-side public/review/security/publish predicates, generic denial paths, API/CLI/MCP tests | Broader cross-surface regression matrix for future role-gated MCP/admin tools |
| Architecture references a restricted, revoked, organization-scoped, or changed release | Private metadata exposure or unsafe desired state | Medium | Consolidated preview binds slug/version/digest through API-owned release predicates; organization visibility is unsupported; no `latest` fallback; generic denial and fail-closed errors | Cross-surface architecture authorization matrix and signed release-reference policy |
| Nested graph cycle, orphan, or oversized payload | Compiler/render denial of service or incorrect routing | Medium | Bounded JSON, deterministic schema/pattern validation, cycle/orphan/edge checks, depth and node limits before persistence | Stress fixtures and production request/resource limits |
| Profile rule confusion exposes a skill in the wrong environment | Sensitive prompt/runtime placement | Medium | Profiles default to deny, explicit denials win, package visibility is separate from runtime exposure, and personal/work/team labels have no implicit tenant permission | Conditional rule semantics and connected-target capability enforcement |
| Diagram injection or unauthorized projection | Misleading UI, script/directive injection, metadata leakage | Medium | Escaped Mermaid and graph labels, browser-derived SVG, authorized-node filtering, accessible outline parity, no package payloads or credentials in projections | Browser security review for any interactive canvas and CSP/readback |
| Fixture state is treated as canonical or applied silently | Destructive target change or loss of local edits | Medium | Strict metadata-only desired-vs-observed fixture, consolidated profile-filtered preview, dry-run planner, no inferred target, and no MVE target write or credential path; unknown fixture fields are rejected | Consent, target identity, staged apply, audit, and rollback design |
| Automatic resolution selects the wrong architecture or leaks local target state | Incorrect configuration recommendation or private path/inventory disclosure | Medium | Detector reads only the MySkills-managed registry, omits paths, uses a strict versioned observation schema, scores only inspectable topology, returns confidence/reasons, fails closed on weak or tied matches, and has no apply path | Independent live-adapter capability tests, consent, signed observations, staged apply, and rollback |
| Legacy metadata visibility or CLI flag bypasses sharing authorization | Unauthorized discovery or grant of a restricted skill | Medium | Generic metadata `visibility` updates and `myskills skills edit --visibility` are rejected/removed; authenticated sharing route and `myskills sharing set` remain the only supported path; organization visibility fails closed | Cross-surface migration tests and future organization tenancy policy |
| Token theft or replay | Account/API misuse | Medium | Opaque hashed sessions and API tokens, scoped tokens, token-free browser login/MFA responses, revocation on disable/delete/password reset, MFA-gated privileged actions, CLI platform keyring storage with user-only file fallback | Browser/device login for CLI |
| Auth brute force across restarts or replicas | Account takeover pressure and noisy abuse | Medium | Shared database-backed auth throttling before expensive auth work | Ingress throttles, alerts, and higher-volume abuse controls |
| Malicious package archive | Path traversal, unsafe install content, secret leakage | Medium | Root manifest validation, archive traversal/symlink/encryption/compression/size/file-count defenses, blocking scans, maintainer review | Background scan jobs, richer policy fixtures, deprecate/revoke workflows |
| Malicious prompt or uncommon secret passes narrow scanner | Reviewer social engineering or private-data exposure | Medium | Baseline secret/command/install-hook rules plus maintainer review | Broader fixture-backed scanner corpus and reviewer diff views |
| Artifact tampering or direct object exposure | Installing unreviewed or modified content | Medium | Internal opaque storage keys, API-owned object writes, byte-size and SHA-256 verification on read, fail-closed mismatch handling | Signed/direct delivery design with audit and authorization preserved |
| Admin/provider role escalation | Owner/admin compromise or broad mapped access | Low to medium | MFA-verified session-only provider/user/role admin, provider secrets rejected from admin API, provider mappings cannot grant owner/admin, last-owner safeguards | Full provider login/linking lifecycle and invite/account recovery policy |
| MCP bearer misuse | Agent sees unauthorized metadata or performs unsafe action | Medium | HTTP adapter validates scoped API token before MCP protocol handling, read-only tools, no bundle payload retrieval, host/origin restrictions | Per-tool authoritative audit and role-gated maintainer/admin tools |
| Audit or error leakage | Token/package/private-data exposure | Low to medium | Sanitized audit listing, generic auth responses, secret scan, no package contents in review/MCP metadata | Structured audit export hardening and operational log guidance |
| Release artifact mismatch | Public tag does not match source or package version | Low | Clean-worktree artifact script, `dist/`-only output guard, tag/version check, checksums, GitHub tag workflow | GitHub Release/container publishing policy |
| Release pipeline compromise or weak provenance | Harder to prove artifacts came from reviewed source | Low to medium | Reproducible source archive, checksums, release workflow, production Docker targets | SHA-pinned actions, digest-pinned base images, SBOM, provenance, signing, protected release tags |

## Public Beta Risk Acceptance

The beta can be public if the repo passes release checks, beta support/compatibility/upgrade docs are current, and GitHub private vulnerability reporting is enabled. The accepted beta risk is that operators must not rely on it for business-critical production workloads until the business-safe release goal is complete.

## Business-Safe Release Security Gates

- Per-tool MCP audit events.
- Background scan jobs and stronger package policy fixtures.
- Ingress abuse controls and alerting around auth-rate-limit pressure.
- Provider login/linking and external identity lifecycle.
- Browser/device login for CLI auth.
- Signed or direct artifact delivery design with authorization and audit.
- Release provenance with pinned actions/images, SBOMs, signatures, and protected tags.
- Private/org/team sharing authorization model before marketing non-public package sharing.
- Architecture ownership and explicit runtime-exposure authorization across
  personal, work, and future team contexts; read projections require
  `architectures:read`, writes require a session, and profile labels must not
  substitute for organization tenancy.
- Visibility migration tests must prove generic metadata and
  `skills edit --visibility` denial, authenticated sharing success, and
  organization-scope rejection.
- Live target connector consent, scoped credentials, capability negotiation,
  conflict handling, apply idempotency, audit, and rollback before any target
  mutation is marketed.
- Production logging, monitoring, backup, restore, upgrade, and incident-response runbooks.
- Final security review after production hardening work.
