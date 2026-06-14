# Roadmap

Version: 0.1.0-alpha.0
Last updated: 2026-06-14

## Release Tracks

- **Responsible public alpha (`v0.1.0-alpha.0`)**: make the repository public with clear alpha limits, sanitized examples, security reporting, reproducible artifacts, and fresh-clone proof.
- **Short-term domain**: point `myskills.sh` to the public `myskills-app` repository until the website exists.
- **Business-safe production release**: harden the alpha into an operator-ready release with stronger audit, background scanning, skill evals, provider lifecycle, artifact delivery, CLI credential storage, deploy/ops guidance, and upgrade policy. See [BUSINESS_SAFE_RELEASE_GOAL.md](BUSINESS_SAFE_RELEASE_GOAL.md).

## Milestone 0: Private Project Setup

Goal: create a clean product repo and public-ready plan.

Acceptance:

- Private personal repo exists.
- Public-safe README, architecture, auth, data, API/MCP/CLI, security, and roadmap docs exist.
- Privacy and structure checks pass.
- Public docs and examples contain no private-source carryover.

## Milestone 1: Backend Foundation Vertical Slice

Goal: prove the proper backend with a thin, runnable vertical slice.

Deliverables:

- TypeScript workspace packages under `apps/api`, `packages/core`, `packages/auth`, and `packages/skill-package`.
- Fastify API scaffold.
- Postgres migrations for users, roles, settings, skills, versions, platform variants, artifacts, scan runs/findings, jobs, and audit events.
- Skill versioning model with semantic version uniqueness, immutable release records, release metadata, and artifact checksums.
- Seed data and local Docker Compose.
- Package manifest validation and basic package risk scanning.
- API tests for health, auth-required `/v1/me`, and public approved skill search.

Acceptance:

- `npm run check` passes.
- A skill package can be created as a DB record with an artifact reference.
- Registry operation does not depend on a source-control host.
- Local setup can run Postgres plus object storage through Docker Compose.
- Production packaging has API, web, and HTTP MCP container targets, a production Compose example, deployment documentation, and a production env preflight.

Current status: in progress. The first API and schema slice exists with email/password session auth, hash-only single-use email verification and password reset action tokens, SMTP/local auth notification delivery, TOTP MFA challenge flow, hashed recovery codes, MFA-verified admin registration/user management with sanitized audit listing, MFA-verified non-secret provider config and claim-to-role mapping management, MFA-verified local role editing with owner-only privileged-role safeguards, hashed scoped API tokens with browser account management and admin monitoring/revocation, public search/detail endpoints, MCP token introspection with `skills:read` scope and API-owned session decision audit events, authenticated package intake with strict root-manifest integrity checks, user-owned submitted-skill export, MFA-gated privileged submission, server-side `.zip` archive extraction, scan evidence, S3-compatible object-storage-backed artifact writes and reads, MFA-gated maintainer review approve/publish actions with approved-unpublished queue visibility, authorized release metadata and bundle delivery, local `.zip` archive parsing for package validation/submission tooling, a React web app for public registry browsing/detail/export guidance, author `.zip` package submission, maintainer review approval/publication, and owner/admin registration/user/provider/role/audit console workflows, read-only MCP stdio and stateless Streamable HTTP servers for registry discovery/info/install guidance, a starter CLI for validation, scanning, prompt-based login/logout with API-URL-scoped stored sessions, search, info, whoami, submit, review actions, verified export, local install/list/update/rollback, and API-token management, plus first-pass production container packaging, opt-in web analytics support, and deployment preflight checks. Queued email delivery, platform keychain CLI token storage, authoritative per-tool MCP audit events, provider login/linking, external identity lifecycle, signed-url/direct object delivery, platform-specific install adapters, skill backup jobs, version-history browsing, background scan jobs, and release automation are still future work.

## Milestone 2: Auth And User Management Foundation

Goal: replace external identity assumptions with direct user management.

Deliverables:

- Email/password auth.
- Email verification and password reset.
- Registration modes: closed, request, open.
- Admin user bootstrap.
- Roles and scoped permissions.
- MFA with TOTP and recovery codes.
- Optional provider mapping spike.
- Hashed scoped API tokens for CLI and MCP.

Acceptance:

- Admin can enable/disable registration.
- Users can register only according to instance policy.
- MFA-protected user flows pass.
- Provider config and claim-to-role mapping administration requires an MFA-verified owner/admin session; provider secrets are rejected and provider mappings cannot grant `owner` or `admin`.
- API, web, CLI, and MCP use the same user/role and token-scope decisions.
- Disabled users and revoked tokens fail immediately.

## Milestone 3: Package Validation, Submission, And Registry MVP

Goal: make skills safe and useful enough to publish privately.

Deliverables:

- Manifest schema.
- Skill versioning workflows for submitting, reviewing, publishing, deprecating, revoking, installing, updating, and rolling back specific versions.
- Package archive parser with traversal, symlink, encryption, compression, size, and file-count defenses.
- Skill payload validation.
- Secret scanning and risky-content scanning.
- Drafts, submissions, review queue, approval, publish, deprecate, revoke.
- Search, detail, and authorized bundle delivery.
- User-owned export for submitted packages and approved releases.
- Skill backup options: account-level export archives, scheduled registry backups, and restore rehearsal guidance.
- Version history viewing for skill owners, users, and maintainers, including release state, scan status, artifact checksums, and rollback/install guidance.
- Background scan jobs and immutable artifact records.

Acceptance:

- Invalid, unreviewed, failed-security, deprecated, and revoked packages are handled correctly.
- Authorized users can install approved packages.
- Unauthorized users cannot infer restricted packages.

## Milestone 4: CLI MVP

Goal: support author and user workflows from the terminal.

Deliverables:

- `myskills` CLI package.
- Login, whoami, logout, token storage.
- Init, validate, scan, package, submit.
- Search, info, install, export, list, update, rollback.
- CLI integration tests against local API.

Acceptance:

- A new user can login, search, install, list, update, and rollback.
- An author can create, validate, scan, package, and submit a draft.

## Milestone 5: Web App MVP

Goal: make the registry useful without the CLI.

Deliverables:

- Browse/search/filter UI.
- Skill detail pages.
- Submit flow.
- Maintainer review dashboard.
- Admin user/settings console.
- Accessible responsive design.
- Apply the supplied My Skills identity system across the web app: Paper/Slate/Coral/Amber/Teal palette, typography, surfaces, states, and refreshed screenshot evidence.

Acceptance:

- Common user, author, maintainer, and admin workflows work in browser tests.
- Text and controls fit on mobile and desktop.

Current status: public browse/search, skill detail, release metadata, export-guidance views, email/password login/logout, password reset, account settings, MFA setup/reset/removal, current-user refresh, session-aware API calls, authenticated author `.zip` package submission, author submitted-version export, maintainer review dashboard workflows for approval/publication, user API-key management, and owner/admin console workflows for registration, user status actions, role updates, API-key monitoring/revocation, provider metadata/mappings, and audit review exist. The supplied My Skills logo and favicon kit is wired into the web app; the broader color, typography, surface, and component refresh from the identity guidelines remains planned. Private draft management, version-history viewing, backup/restore workflows, and remaining instance settings administration are still future work.

## Milestone 6: Skill Evals

Goal: make skill quality measurable before and after publication.

Deliverables:

- Version-aware eval suite definitions for behavior, installability, compatibility, safety, and regression checks.
- Eval run records tied to skill versions, artifacts, target platforms, runner version, and review/submission context.
- Maintainer-visible eval evidence in review workflows.
- Public-safe eval summaries on approved releases.
- CLI commands for local eval execution against package directories and archives.
- API endpoints for eval results and submission review evidence.

Acceptance:

- A submitted skill version can include or trigger eval evidence without mutating previous approved versions.
- Failed, warning, skipped, and incompatible eval results are represented distinctly.
- Maintainers can make approval decisions with scan findings and eval evidence together.
- Public users see safe summary status only; detailed failure evidence is authorization-gated.

Current status: planned.

## Milestone 7: MCP Production Surface

Goal: expose safe agent-facing registry discovery.

Deliverables:

- SDK-backed MCP endpoint.
- Read-only skill discovery and install-instruction tools.
- Role-gated maintainer/admin read tools.
- Client compatibility notes.
- MCP audit events.

Acceptance:

- MCP clients can discover authorized skills.
- MCP cannot return unauthorized metadata or package contents.
- Tool results align with API and CLI authorization tests.

Current status: first stdio and stateless Streamable HTTP MCP servers exist with `search_skills`, `get_skill_info`, and `get_install_instructions`. Calls require an API token with `skills:read`, reject session tokens through the API, write sanitized API-owned `mcp.session` audit events for allow/deny authorization decisions, and avoid bundle payload retrieval. Role-gated maintainer/admin tools and authoritative per-tool audit events are still future work.

## Milestone 8: Public Release Hardening

Goal: make the repo public-ready.

Deliverables:

- Installation docs.
- Deployment docs for Docker Compose and at least one managed target.
- Security review.
- Threat model update.
- License and security policy review.
- Release workflow.
- Example package set with no private content.

Acceptance:

- Fresh clone can run checks and local demo.
- Secret scan passes.
- Public docs contain no private-source carryover.
- First public release tag is reproducible.

Current status: responsible public alpha docs, public security policy, threat model, production Docker targets, production Compose example, production env preflight, public-safe example skill package, deterministic alpha-release check, and tag-triggered release artifact workflow exist. Fresh-clone rehearsal, public visibility switch, and first reproducible alpha tag remain planned.

## Milestone 9: Business-Safe Production Release

Goal: turn the public alpha into a release that a business can operate with clear trust boundaries, support expectations, upgrade paths, and incident response.

Deliverables:

- Provider login/linking and external identity lifecycle.
- Background package scan jobs with durable scan evidence and retry policy.
- Skill eval suites, durable eval runs, and review/release gates for quality and compatibility evidence.
- Authoritative per-tool MCP audit events and role-gated maintainer/admin tools.
- Platform keychain storage for CLI credentials.
- Signed or direct object delivery that preserves authorization, integrity checks, and audit.
- Platform-specific install adapters.
- Production deploy guidance with backup, restore, monitoring, logging, upgrade, and rollback runbooks.
- Release publishing policy for GitHub Releases, container images, and package artifacts.

Acceptance:

- Fresh production-like deploy rehearsal passes from a clean clone.
- Security/threat-model findings above accepted alpha risk are closed or tracked with explicit mitigations.
- Admin, maintainer, author, user, CLI, API, MCP, eval, and deployment workflows have deterministic verification.
- Upgrade from the alpha data model is tested or migration limits are clearly documented.

## Milestone 10: Public Website

Goal: build a full website for MySkills at `myskills.sh`.

Short-term:

- Make the repository public as `myskills-app`.
- Point `myskills.sh` to the public GitHub repository or a minimal redirect page.

Deliverables:

- Product homepage with clear alpha status and install path.
- Documentation hub for setup, deployment, CLI, API, MCP, package authoring, security, and release notes.
- Example skill gallery using public-safe packages.
- Screenshots or short demos for web, CLI, MCP, submission, review, and install workflows.
- Release/download page for source artifacts and future containers/packages.
- Security-reporting link.

Acceptance:

- `myskills.sh` gives a new user a clear path from product overview to running the local demo.
- Website content does not duplicate stale docs; it links to canonical repo docs where appropriate.
- The site can be deployed independently from the app services.
