# Roadmap

Version: 0.1.0-alpha.0
Last updated: 2026-06-17

## Release Tracks

- **Responsible public alpha (`v0.1.0-alpha.0`)**: make the repository public with clear alpha limits, sanitized examples, security reporting, reproducible artifacts, and fresh-clone proof.
- **Short-term domain**: point `myskills.sh` to the public `myskills` repository until the website exists.
- **Business-safe production release**: harden the alpha into an operator-ready release with stronger audit, background scanning, skill evals, provider lifecycle, artifact delivery, CLI credential storage, deploy/ops guidance, and upgrade policy. See [BUSINESS_SAFE_RELEASE_GOAL.md](BUSINESS_SAFE_RELEASE_GOAL.md).

## Current Focus

- Finish the public-alpha release gate: fresh-clone rehearsal, public visibility switch, first reproducible alpha tag, and release artifact verification.
- Keep production-hardening items tracked without blocking the responsible public alpha unless they close accepted alpha risk.
- Complete the remaining web-app MVP gaps that affect first-user clarity: private draft management, instance settings administration, and the broader identity-system refresh.
- Preserve the API as the canonical registry and trust boundary for sync-related work; local and connected-tool state should reconcile through reviewable changes, not silent overwrites.

## Roadmap Shape

- **Registry MVP**: Milestones 0-5 prove the private registry, auth, package, CLI, and web workflows.
- **Quality and agent surfaces**: Milestones 6-7 add eval evidence and production-grade MCP access.
- **Public alpha gate**: Milestone 8 makes the repo and first release public-ready.
- **Production hardening**: Milestone 9 turns the alpha into an operator-ready deployment.
- **Public website**: Milestone 10 gives `myskills.sh` a proper product and documentation surface.
- **Future product expansion**: connected skills management, cross-tool configuration, and optional usage telemetry.

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

Current status:

Done:

- Core API/schema slice, session auth, email verification/reset tokens, TOTP MFA, recovery codes, local roles, scoped API tokens, and sanitized audit listing.
- Public search/detail endpoints, authenticated package intake, archive extraction defenses, scan evidence, artifact storage, maintainer review, publication, release metadata, and authorized bundle delivery.
- Web workflows for public browsing, package submission, maintainer review, publication, registration/user/provider/role administration, and audit review.
- Read-only MCP stdio and stateless Streamable HTTP discovery servers.
- CLI workflows for validation, scanning, login/logout, search/info, submission, review actions, verified export, local install/list/update/rollback, and API-token management.
- First-pass production container packaging and deployment preflight checks.

Remaining:

- Queued email delivery.
- Platform keychain storage for CLI credentials.
- Authoritative per-tool MCP audit events.
- Provider login/linking and external identity lifecycle.
- Signed or direct object delivery that preserves authorization and integrity.
- Platform-specific install adapters.
- Background scan jobs.
- Release automation.

Blocking next release:

- Public alpha blockers are tracked in Milestone 8. Remaining production items above move to Milestone 9 unless they close an accepted alpha risk.

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

Current status:

Done:

- Public browse/search, skill detail, release metadata, and export-guidance views.
- Email/password login/logout, MFA challenge completion, current-user refresh, and session-aware API calls.
- Authenticated author `.zip` package submission.
- Maintainer review dashboard workflows for approval/publication.
- Owner/admin console workflows for registration, user status actions, role updates, provider metadata/mappings, and audit review.
- Supplied My Skills logo and favicon kit wired into the web app.

Remaining:

- Broader color, typography, surface, and component refresh from the identity guidelines.
- Private draft management.
- Remaining instance settings administration.

## Milestone 6: Skill Evals

Goal: make skill quality measurable before and after publication.

Depends on: Milestones 1, 3, and 5.

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

Depends on: Milestones 1, 2, and 4.

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

Current status:

Done:

- First stdio and stateless Streamable HTTP MCP servers exist with `search_skills`, `get_skill_info`, and `get_install_instructions`.
- Calls require an API token with `skills:read`, reject session tokens through the API, write sanitized API-owned `mcp.session` audit events for allow/deny authorization decisions, and avoid bundle payload retrieval.

Remaining:

- Role-gated maintainer/admin read tools.
- Authoritative per-tool audit events.
- Broader client compatibility notes and tests.

## Milestone 8: Public Release Hardening

Goal: make the repo public-ready.

Depends on: Milestones 0-5.

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

Current status:

Done:

- Responsible public-alpha docs.
- Public security policy and threat model.
- Production Docker targets, production Compose example, and production env preflight.
- Public-safe example skill package.
- Deterministic alpha-release check.
- Tag-triggered release artifact workflow.

Blocking next release:

- Fresh-clone rehearsal.
- Public visibility switch.
- First reproducible alpha tag.
- Release artifact verification from the public tag.

## Milestone 9: Business-Safe Production Release

Goal: turn the public alpha into a release that a business can operate with clear trust boundaries, support expectations, upgrade paths, and incident response.

Depends on: Milestone 8 plus the production portions of Milestones 6 and 7.

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

Depends on: Milestone 8 for public-alpha positioning. The site can start before Milestone 9.

Short-term:

- Make the repository public as `myskills`.
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

## Future Product Expansion

These items are intentionally downstream from the public alpha and production-hardening work. They are strategic product directions, not public-alpha blockers.

### Connected Skills Management

Goal: let users connect their AI tools and systems to MySkills for clean, user-controlled, bi-directional skills management across apps, machines, and projects.

Depends on: Milestones 4, 5, 7, and the platform-install-adapter work in Milestone 9.

Deliverables:

- Connected-tool model for AI systems such as Codex, ChatGPT, Claude Code, local agents, and future MCP-compatible clients.
- Tool and instance registration flow with explicit user authorization, scopes, revocation, health checks, and last-sync status.
- Bi-directional sync design that keeps MySkills as the canonical registry while reconciling local tool state through staged, reviewable changes.
- Placement rules for where skills should be available, including per-tool, per-instance, per-machine, and project-level designation.
- Configuration-management groundwork for tool-specific skill enablement, disabled-on-load state, and future app configuration updates where supported by each tool.
- Conflict handling for local edits, remote updates, missing tools, unsupported capabilities, deleted skills, renamed projects, and immutable published versions.
- Clean skills management interface showing which skills are enabled in which AI tools, apps, instances, machines, and projects.
- Web workflows to add, remove, enable, disable, update, roll back, and relocate skills across connected tools.
- CLI and API commands for connected-tool inventory, sync status, dry-run reconciliation, apply, rollback, and audit review.
- Optional skill usage telemetry integration with per-user opt-in, transparent event types, retention controls, export/delete controls, and no required telemetry for core sync.

Acceptance:

- A user can connect at least two supported AI tool instances, choose which skills are available in each, and see the resulting placement state in the web UI.
- A dry-run sync clearly separates no-op, install, update, disable, remove, conflict, and unsupported actions before anything is applied.
- Applying a sync writes auditable records and can be rolled back where the target tool supports rollback.
- Project-level designation works for at least one supported local tool without changing unrelated projects.
- The management UI makes it obvious where each skill is enabled, disabled, missing, outdated, or blocked by tool limitations.
- Optional telemetry is disabled by default, can be enabled or disabled without affecting skill sync, and exposes only documented usage events.
