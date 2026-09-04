# Roadmap

Version: 0.1.0-beta.5
Document revision: 0.2.0-draft
Last updated: 2026-09-01

## Release Tracks

- **Responsible public alpha (`v0.1.0-alpha.0`)**: archived release track for the first public repository and reproducible source artifact gate.
- **Public beta (`v0.1.0-beta.1`)**: superseded external trial release that established owner-controlled hosted access and documented self-hosting boundaries.
- **Beta follow-up (`v0.1.0-beta.2`)**: released 2026-07-13 with local onboarding, artifact/review safety, public CLI packaging, static quality gates, release discipline, and reconciled docs. See [BETA_RELEASE_GOAL.md](BETA_RELEASE_GOAL.md).
- **Hosted beta baseline**: The beta.2 Railway deployment is the documented hosted baseline; confirm the current commit and health by live read-back before describing `myskills.sh` as running it.
- **Business-safe production release**: harden the beta into an operator-ready release with stronger audit, background scanning, skill evals, provider lifecycle, artifact delivery, trusted publishing, deploy/ops guidance, and upgrade policy. See [BUSINESS_SAFE_RELEASE_GOAL.md](BUSINESS_SAFE_RELEASE_GOAL.md).

## Current Focus

- Keep the documented Phase 1 beta.2 Railway baseline separate from this local
  Phase 2 branch. Any current hosted claim requires a live read-back; a local
  migration or test is not hosted evidence.
- Complete the supported-runtime, disposable-Postgres, browser/UAT, security,
  and review gates for the local Phase 2 branch before considering a hosted
  trial.
- Verify and review the current Skill Architecture Control Plane slices that let
  users choose topology patterns, manage immutable revisions, understand
  diagrams, manage organization sharing, and inspect connected-target metadata
  without leaking private skill content.
- Preserve the API/Postgres registry as the canonical trust boundary. Connected
  state must enter as consented, reviewable, metadata-only evidence before any
  future write path is considered.
- Keep live adapters, target mutation, public sync routes, package install,
  and live apply/rollback clearly blocked until their authorization and
  verification gates are complete.

## Roadmap Shape

- **Registry MVP**: Milestones 0-5 prove the private registry, auth, package, CLI, and web workflows.
- **Quality and agent surfaces**: Milestones 6-7 add eval evidence and production-grade MCP access.
- **Public alpha gate**: Milestone 8 makes the repo and first release public-ready.
- **Production hardening**: Milestone 9 turns the beta into an operator-ready deployment.
- **Public website**: Milestone 10 gives `myskills.sh` a proper product and documentation surface.
- **Future product expansion**: connected skills management, cross-tool configuration, and optional usage telemetry.

## Milestone 0: Private Project Setup

Goal: create a clean product repo and public-ready plan.

Historical acceptance:

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

- Core API/schema slice, session auth, email verification/reset/invitation/email-change tokens, TOTP MFA, recovery codes, local roles, scoped API tokens, browser account management, admin API-token monitoring/revocation, and sanitized audit listing.
- Public search/detail endpoints, authenticated package intake, archive extraction defenses, scan evidence, artifact storage, maintainer review, publication, release lifecycle controls, release metadata, authorized bundle delivery, and user-owned submitted-skill export/withdrawal.
- Web workflows for public browsing, package submission, author withdrawal, maintainer review, publication, lifecycle controls, registration/user/provider/role administration, and audit review.
- Read-only MCP stdio and stateless Streamable HTTP discovery servers.
- CLI workflows for validation, scanning, login/logout, auth status, API URL selection/config, doctor diagnostics, keyring-first credential storage, search/info, submission, author withdrawal, review actions, skill metadata/lifecycle controls, release lifecycle controls, team/sharing commands, verified export, local install/list/update/rollback, and API-token management.
- First-pass production container packaging, opt-in web analytics support, and deployment preflight checks.

Remaining:

- Queued email delivery.
- Browser/device login for CLI auth.
- Authoritative per-tool MCP audit events.
- Provider login/linking and external identity lifecycle.
- Signed or direct object delivery that preserves authorization and integrity.
- Platform-specific install adapters.
- Skill backup jobs.
- Version-history browsing.
- Background scan jobs.
- Release automation.

Blocking next release:

- Beta.2 acceptance is tracked in [BETA_RELEASE_GOAL.md](BETA_RELEASE_GOAL.md). Remaining production items above stay in Milestone 9 unless they close an accepted beta risk.

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
- Skill versioning workflows for submitting, withdrawing, reviewing, publishing, deprecating, unpublishing, restoring, revoking, deleting, installing, updating, and rolling back specific versions.
- Package archive parser with traversal, symlink, encryption, compression, size, and file-count defenses.
- Skill payload validation.
- Secret scanning and risky-content scanning.
- Drafts, submissions, review queue, approval, requested changes, rejection, publish, deprecate, unpublish, revoke, restore, delete.
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
- Email/password login/logout, password reset, account settings, MFA challenge/setup/reset/removal, current-user refresh, and session-aware API calls.
- Authenticated author `.zip` package submission and author submitted-version export.
- Maintainer review dashboard workflows for approval, requested changes, rejection, and publication.
- Owner/admin lifecycle controls for skill metadata, skill archive/restore/delete, and release deprecate/unpublish/revoke/restore/delete.
- User API-key management.
- Owner/admin console workflows for registration, user status actions, role updates, API-key monitoring/revocation, provider metadata/mappings, and audit review.
- Supplied My Skills logo and favicon kit wired into the web app.

Remaining:

- Broader color, typography, surface, and component refresh from the identity guidelines.
- Private draft management.
- Version-history polish.
- Backup/restore workflows.
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
- The API-owned MCP session check accepts an API token with either `skills:read` or `architectures:read`; registry tools require `skills:read`, architecture projection tools require `architectures:read`, session tokens are rejected, sanitized API-owned `mcp.session` audit events record allow/deny decisions, and bundle payload retrieval is avoided.

Remaining:

- Role-gated maintainer/admin read tools.
- Authoritative per-tool audit events.
- Broader client compatibility notes and tests.

## Milestone 7A: Skill Architecture Control Plane MVE

Goal: make skill architecture a versioned, reviewable desired-state object that
supports nested router-to-router-to-leaf patterns, logical profile/environment
selection, deterministic diagrams, and safe dry-run reconciliation.

Depends on: Milestones 1, 2, 3, 5, and 7.

Branch implementation present (not release acceptance):

- `ArchitectureSpecV1` shells and immutable revisions with explicit typed
  router/leaf nodes, exact slug/version/SHA-256 release references, and
  `flat`, `domain-router`, and `multi-level-router` descriptors.
- API-owned persistence and optimistic revision conflict checks. A graph edit
  appends a revision; it never rewrites an earlier spec or package release.
- Fail-closed profile/environment selection with default-deny and explicit
  denial precedence. Runtime exposure remains distinct from package visibility,
  architecture ownership, and target delivery mode.
- Deterministic schema, graph, profile-rule, release-reference, and digest
  validation plus one consolidated preview:
  `{ revision?, compiled, graph, outline, diagram, plan? }`; organization-only
  projections omit the raw revision and require explicit organization context.
- API graph/diagram artifact, browser SVG, downloadable JSON/Mermaid, and
  accessible outline/table projections come from one filtered compilation.
  Diagram output is derived and not canonical.
- Explicit fixture-backed planning for noop/install/update/downgrade/enable/
  disable/remove/conflict/unsupported/configure-router. Unknown fields,
  paths, credentials, package content, and implicit targets are rejected; plans
  are always dry-run/no-apply.
- Architecture list/detail/revision/preview API routes, web workbench, and
  read-only CLI/MCP projections with the `architectures:read` scope boundary.

The current branch includes focused core/API, Postgres, browser, CLI, MCP,
privacy, and structure test suites for these contracts. This is a source/test
inventory, not a passing-gate claim. A fresh supported-runtime release gate,
disposable-Postgres run, browser/UAT review, security review, and live Railway
read-back remain separate requirements.

## Milestone 7B: Tenancy and organization policy

Goal: allow user and team architecture ownership, organization sharing, and
effective child-team membership without treating labels or stale membership
rows as authority.

Branch foundations present (fresh verification pending):

- 0016 user/team owner references and policy-v1 architecture access decisions.
- 0017 organizations, immutable canonical policy revisions and SHA-256
  digests, active memberships/invitations, nullable team parentage, and
  policy-bound skill/architecture grants.
- Organization/team API routes, organization-safe architecture read/preview
  evaluation, current-policy/status checks, and organization selection in the
  architecture workbench.
- Atomic policy-bound architecture grant replacement with current-revision
  concurrency checks, audited GET/PUT routes, and manager-only web save/revoke
  controls. Organization members receive read/preview access only.

Deferred:

- Complete CLI/MCP architecture organization-grant write parity. CLI skill
  visibility grants can target organizations; architecture grant replacement
  remains an API/web manager control.
- Provider-derived roles, public architecture publishing, and conditional
  runtime exposure.

## Milestone 7C: Connected environment targets

Goal: represent physical target bindings and consented observations separately
from logical environments, with a strict privacy boundary.

Branch foundations present (fresh verification pending):

- 0018 target and append-only observation schema, owner/binding/status/consent,
  capability and identity digests, generation fencing, health, and safe
  metadata.
- API registration, read, consent, observation, health, and revoke routes.
- Organization and target web workbenches for membership/policy, exact target
  bindings, consent, health, safe observations, and revoke controls.
- Read-only core adapter contract (`observe`/`health`) with mutation
  capability names disabled. A fixture-tested Codex adapter reads only an
  explicit root/profile and safe metadata/frontmatter; it does not read or
  emit prompts, bodies, paths, URLs, credentials, or package bytes.

Deferred:

- Live adapter invocation, automatic home/profile discovery, provider/API
  connectors, target writes, package installation, and credential handling.
- CLI/MCP target management parity and live provider readback.

## Milestone 7D: Sync control, recovery, and fencing

Goal: make reconciliation reviewable and recoverable before any target write
is considered.

Branch foundations present (fresh verification pending):

- 0019 tenant-scoped sync runs, steps, baselines, receipts, recovery evidence,
  leases, fencing, generations, digests, and safe metadata constraints.
- Core/API fixture service, in-memory executor, and persisted Postgres store
  for approval, synthetic apply/verify/rollback transitions, recovery
  decisions, idempotency, and lease-loss tests.

The bounded sync contract allows at most 500 steps and 2,004 append-only
receipts per run. That capacity covers a 1,002-receipt max-step lifecycle, one
full apply/verify retry, and two recovery/terminal receipts; further retries
require a new bounded run. These are fixture/control-plane limits and do not
enable live target writes.

Deferred:

- Public sync-run routes, live adapter executors, package installers,
  filesystem writers, and any live apply or rollback.

## Milestone 7E: Pattern migration and editor history

Goal: let users change topology safely while preserving release identity,
exposure intent, and revision history.

Branch foundations present (fresh verification pending):

- Pure `derive-shell` pattern migration for every built-in pattern pair,
  bounded mappings/fallbacks, deterministic diff/digests, and fail-closed
  exposure preservation.
- 0020 append-only migration lineage with source/target revision bindings,
  mapping/diff safety checks, digests, and idempotency constraints.
- API preview/create service and atomic Postgres shell/revision/lineage
  persistence with idempotent replay. Source identity, grants, and targets
  are never copied.
- Semantic web editor controls, registry release lookup, deterministic layout,
  SVG plus JSON/Mermaid downloads and a plain-outline projection, immutable
  save, revision history/diff, use-as-draft, conflict-preserving draft
  preview, and pattern migration preview/create controls.

Deferred:

- CLI/MCP pattern-migration write commands and durable server-side diagram
  artifacts/versioned layout data. No target or grant rebinding is allowed by
  the migration contract.

### Phase 2 migration order

The current branch adds the architecture migrations in lexical order: 0015 base
architectures, 0016 user/team ownership, 0017 organizations and sharing, 0018
targets and observations, 0019 sync control, and 0020 pattern-migration
lineage. The current branch wires the relevant local services, API routes, and
web controls on top of these tables. Migration presence alone does not enable
public sync routes or live operations. Existing standalone teams are not
backfilled into an organization. A fresh disposable-Postgres/runtime run is
required before treating this sequence as release or hosted-migration evidence.
Before production applies migration 0019, the operator must verify a restorable
database backup and the backup-restore procedure, record the accepted data-loss
boundary, and assess and approve the expected Postgres lock window for its
`ALTER TABLE`, constraint, type, function, and table operations. A local pass or
backup artifact alone does not establish either gate; if either is unapproved,
stop before 0019 and use the deployment runbook's repair-forward or
pre-migration restore path.

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

- Responsible public-alpha docs archived alongside the current beta goal.
- Public security policy and threat model.
- Production Docker targets, production Compose example, and production env preflight.
- Public-safe example skill package.
- Deterministic prerelease check.
- Self-contained public CLI tarball smoke with an exact file allowlist and clean temporary install.
- ESLint and explicit web typecheck gates on supported Node LTS lines.
- Tag-triggered release artifact workflow.
- Public visibility switch.
- First reproducible beta tag.
- Release artifact verification from the public beta tag.
- Fresh-clone local and staging/user-test rehearsal against the immutable beta.2 release commit.
- Live GitHub branch/tag rules and security-setting readback.
- Explicit tag, distribution, and production-deploy approvals.

## Milestone 9: Business-Safe Production Release

Goal: turn the public beta into a release that a business can operate with clear trust boundaries, support expectations, upgrade paths, and incident response.

Depends on: Milestone 8 plus the production portions of Milestones 6 and 7.

Deliverables:

- Provider login/linking and external identity lifecycle.
- Background package scan jobs with durable scan evidence and retry policy.
- Skill eval suites, durable eval runs, and review/release gates for quality and compatibility evidence.
- Authoritative per-tool MCP audit events and role-gated maintainer/admin tools.
- Browser/device login for CLI auth.
- Signed or direct object delivery that preserves authorization, integrity checks, and audit.
- Platform-specific install adapters.
- Production deploy guidance with backup, restore, monitoring, logging, upgrade, and rollback runbooks.
- Release publishing policy for GitHub Releases, container images, and package artifacts.

Acceptance:

- Fresh production-like deploy rehearsal passes from a clean clone.
- Security/threat-model findings above accepted beta risk are closed or tracked with explicit mitigations.
- Admin, maintainer, author, user, CLI, API, MCP, eval, and deployment workflows have deterministic verification.
- Upgrade from the alpha data model is tested or migration limits are clearly documented.

## Milestone 10: Public Website

Goal: build a full website for MySkills at `myskills.sh`.

Depends on: Milestone 8 for public-release positioning. The site can start before Milestone 9.

Current foundation:

- The repository is public as `jremick/myskills`.
- The beta application is documented at `myskills.sh`; its current serving
  commit and health require live read-back.
- The repository remains the canonical documentation and self-hosting surface until a separate docs/product site is delivered.

Deliverables:

- Product homepage with clear public beta/prerelease status and install path.
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

These items are intentionally downstream from the public beta and production-hardening work. They are strategic product directions, not public-beta blockers.

### Connected Skills Management

Goal: let users connect their AI tools and systems to MySkills for clean, user-controlled, bi-directional skills management across apps, machines, and projects.

Depends on: Milestones 4, 5, 7, 7A-7E, and the platform-install-adapter work
in Milestone 9. Phase 2 currently provides target metadata, consent,
read-only observation, and fixture sync-control foundations; it does not make
this connected-management goal available.

Deliverables:

- Connected-tool model for AI systems such as Codex, ChatGPT, Claude Code, local agents, and future MCP-compatible clients.
- Tool and instance registration flow with explicit user authorization, scopes, revocation, health checks, and last-sync status.
- Bi-directional sync design that keeps MySkills as the canonical registry while reconciling local tool state through staged, reviewable changes.
- Extend the Phase 2 target and fixture foundations into capability negotiation,
  auditable apply/rollback workflows, and provider-specific adapters only after
  live pilots and independent security review.
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
