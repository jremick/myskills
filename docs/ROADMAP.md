# Roadmap

Version: 0.1.0-beta.6
Document revision: 0.3.0-draft
Last updated: 2026-09-25

## Release Tracks

- **Responsible public alpha (`v0.1.0-alpha.0`)**: archived release track for the first public repository and reproducible source artifact gate.
- **Public beta (`v0.1.0-beta.1`)**: superseded external trial release that established owner-controlled hosted access and documented self-hosting boundaries.
- **Beta follow-up (`v0.1.0-beta.2`)**: released 2026-07-13 with local onboarding, artifact/review safety, public CLI packaging, static quality gates, release discipline, and reconciled docs. See [BETA_RELEASE_GOAL.md](BETA_RELEASE_GOAL.md).
- **Operational beta (`v0.1.0-beta.5`)**: released with the governed Codex workspace install/update/rollback path and recorded staging and production verification. See [Operational Beta Delivery](OPERATIONAL_BETA_DELIVERY.md).
- **CLI follow-up (`v0.1.0-beta.6`)**: released with the dry-run-only work/team Codex bootstrap planner. This CLI release did not promote Railway.
- **Hosted beta baseline**: the operational beta.5 application is the latest documented deployment baseline. Confirm the current commit and health by live read-back; historical acceptance is not a current runtime check.
- **Business-safe production release**: harden the beta into an operator-ready release with stronger audit, background scanning, skill evals, provider lifecycle, artifact delivery, trusted publishing, deploy/ops guidance, and upgrade policy. See [BUSINESS_SAFE_RELEASE_GOAL.md](BUSINESS_SAFE_RELEASE_GOAL.md).

## Current Focus

- Review the existing backlog together with the adoption features below before
  assigning release scope, delivery order, owners, or dates.
- Make first use easier: native MCP skill delivery, better authoring and imports,
  optional task-aware recommendations, and simpler self-hosting and deployment.
- Preserve the API/Postgres registry, immutable reviewed releases, authorization,
  and audit as the shared foundation for each new surface.
- Keep the proven workspace-scoped Codex companion separate from broader
  cross-tool sync and full architecture execution, which remain future work.
- Use the operational acceptance ledger and current source to reconcile older
  milestone status lists during the next roadmap review. Earlier branch and
  beta.2 labels below are historical; they do not supersede the release tracks.

## Adoption Features For Delivery Review

Status: added to the roadmap; implementation scope and delivery order are pending
review. IDs identify workstreams, not priority. These extend existing milestones
and do not create separate registries or release systems.

| ID | Outcome | Existing milestone | Detail |
| --- | --- | --- | --- |
| MCP-1 | Agents discover and load authorized skills through native MCP Skills. | 7 | [Native MCP skill delivery](#native-mcp-skill-delivery-mcp-1) |
| AUTHOR-1 | Authors create, edit, import, and submit skills without manually rebuilding packages. | 3, 4, 5 | [Authoring and imports](#authoring-and-imports-author-1) |
| REC-1 | Users and agents find relevant skills from a task description. | 1, 6, 7 | [Task-aware recommendations](#task-aware-recommendations-rec-1) |
| HOST-1 | Operators reach a usable, maintainable instance with fewer steps and less build work. | 8, 9, 10 | [Self-hosting and deployment](#self-hosting-and-deployment-host-1) |

The [self-hosting investigation](SELF_HOSTING_INVESTIGATION.md) records current
friction, options, dependencies, and proposed verification. It recommends release
images and a setup helper as the first delivery candidate; prioritization remains
open until the full roadmap review.

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

MCP-1 extends this existing read-only surface with authorized content delivery.
The current tool contract remains unchanged until that extension is implemented
and its compatibility and authorization checks pass.

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

Historical Phase 2 foundation below. The later operational beta adds a separate
contract-v2 Codex workspace companion with guarded installation and update
operations; see [Upgrade Policy](UPGRADE_POLICY.md). Deferred items below concern
broader adapters and management parity beyond that supported path.

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

- Broader provider/API connectors and adapter invocation beyond the supported
  Codex workspace companion. Automatic home/profile discovery is not enabled.
- CLI/MCP target management parity and live provider readback.

## Milestone 7D: Sync control, recovery, and fencing

Goal: make reconciliation reviewable and recoverable before any target write
is considered.

This milestone describes the general architecture sync service and fixture
executor. It does not describe the later per-skill target-operation queue and
Codex companion. Full architecture graph execution remains outside the
[operational beta's proven scope](OPERATIONAL_BETA_DELIVERY.md).

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

## Native MCP Skill Delivery (MCP-1)

Goal: let compatible agents discover and load authorized reviewed skills and
supporting files through the existing MCP connection.

Planned scope:

- Implement the official `io.modelcontextprotocol/skills` extension with
  `skills/list`, `skills/get`, and verified `resources/read` responses.
- Project canonical released packages into complete manifests with stable origin
  identity, frontmatter, byte sizes, and digests. Resolve the mapping between
  stable skill identity and immutable MySkills release identity explicitly.
- Reuse API-owned token, visibility, lifecycle, and artifact decisions on every
  read. Add bounded pagination and content delivery with sanitized per-tool and
  resource audit evidence.
- Preserve existing discovery tools and CLI/API delivery for older clients.
  Expose native delivery only where server and host compatibility are verified.
- Provide connection and first-load guidance with actionable compatibility errors.

Acceptance:

- A supported host discovers a permitted release and loads only the required
  instructions and supporting files through its verified skill-loading path.
- Revoked access, hidden releases, changed digests, malformed paths, and oversized
  packages fail without leaking content. Cached metadata never grants access.
- Existing MCP and CLI clients retain their documented behavior. Reading content
  does not execute code or bypass host approval.

Planning decisions: initial host matrix, package/frontmatter compatibility,
supported file types, release-selection behavior, and audit retention. This work
does not include agent write tools or automatic skill execution.

Reference: [official MCP Skills extension](https://modelcontextprotocol.io/extensions/skills/overview).
Host support must be checked at delivery time.

## Authoring And Imports (AUTHOR-1)

Goal: make a skill easy to create, improve, and bring into the registry while
preserving the existing submission and review process.

Planned scope:

- Private draft workspaces with a Markdown/supporting-file editor, preview,
  frontmatter and manifest assistance, validation, and scan feedback before
  submission. Start from a new template or a permitted existing release.
- Draft history, diffs, stale-edit conflicts, and recovery of unsaved work.
  Published artifacts remain immutable; edits become a draft for a new version.
- Guided folder and ZIP imports through supported browser and CLI paths. Preview
  selected files, exclusions, package metadata, and compatibility adjustments.
- Public GitHub repository, subdirectory, and `SKILL.md` URL imports. Resolve and
  pin a commit during preview, let users choose from collections, and record
  repository/commit/path provenance when submitting the held or reverified bytes.
- Help users correct requested changes and resubmit a new immutable package
  snapshot. Preserve attribution and license information when present.
- Reuse package intake, scan, ownership, visibility, version-conflict, and review
  rules for every entry path. Keep source content untrusted and never run imports.

Acceptance:

- An author creates a multi-file draft, reloads it, corrects a validation error,
  submits it, receives review feedback, and submits a corrected version.
- Folder, ZIP, and GitHub imports show an accurate preview and preserve approved
  bytes and source metadata. A changed branch cannot replace previewed content.
- Concurrent edits, version collisions, traversal, symlinks, unsafe URLs, secrets,
  and resource limits produce clear outcomes; imports cannot bypass review or
  widen visibility. Partial failures do not publish incomplete packages.

Planning decisions: first editor slice, autosave/draft retention, binary-file
support, native frontmatter mapping, and API/CLI parity. Private GitHub access,
continuous repository sync, and AI-generated drafts are separate future choices.

Reference: [SkillBox's GitHub preview/import flow](https://github.com/kitze/skillbox#import-from-github).
It is comparison evidence, not an implementation dependency.

## Task-Aware Recommendations (REC-1)

Goal: find relevant authorized skills from a task description, with useful search
available when model recommendations are disabled or unavailable.

Planned scope:

- A task-based discovery endpoint with web and MCP entry points; evaluate Jev as
  an optional recommendation engine using a user-supplied provider key.
- Compare ranking quality, latency, and reported cost against deterministic search
  on a fixed representative task set, including tasks with no useful match.
- Filter by current authorization and lifecycle before any provider call. Recheck
  results after evaluation and on cache use; return exact release identities.
- Show recommendation method, fallback, and uncertainty. Separate relevance from
  trust, quality, execution authority, and probability of task success.
- Require explicit provider/data-egress configuration, safe credential storage,
  request/cost bounds, and no automatic model calls for basic library use.

Acceptance:

- A measured quality benefit over search justifies the chosen first provider.
- Missing keys, timeouts, provider errors, and capacity limits preserve useful
  search with explicit fallback status; no unauthorized descriptions leave the API.
- Results never activate, install, or execute skills. Provider access can be
  disabled without impairing core registry use.

Planning decisions: credential ownership, provider choice, evaluation rubric,
catalog limits, cost budget, and cache/retention policy. The bounded ranking
experiment need not wait for delivery of the full durable skill-eval platform.
Paid experiments require a separately approved budget.

## Self-Hosting And Deployment (HOST-1)

Goal: reduce operator effort and elapsed time from a fresh machine to a usable
instance, then make upgrades and recovery equally clear.

Planned scope:

- Publish verified, versioned container images and a matching Compose release
  bundle so operators can install without a host Node/npm toolchain or source build.
- Provide a small setup/operations helper with guided inputs, generated protected
  configuration, preflight, first-owner bootstrap, startup, status, and diagnostics.
- Distinguish a disposable local evaluation path from persistent self-hosting.
  Production keeps its auth, email, TLS, storage, and recovery requirements.
- Reuse migration locking, readiness, build identity, coordinated backup, and
  isolated restore tooling. Make updates deliberate and preserve existing data.
- Reduce repeated build work and duplicated deployment configuration. Evaluate a
  Railway template using the same release artifacts and explicit service settings.
- Verify amd64/arm64 support, public image availability, first use, update, and
  recovery before advertising platform support or setup-time claims.

Acceptance and decisions are detailed in the
[self-hosting investigation](SELF_HOSTING_INVESTIGATION.md). No stack rewrite,
combined application image, new storage backend, or new hosting provider is
selected by adding this workstream to the roadmap.

## Next Roadmap Review

Review existing work and the four additions together. Reconcile older status
lists against current source, release records, and fresh runtime evidence where
needed; do not schedule already-delivered work again.

| Review group | Existing work to reconcile | Decision needed |
| --- | --- | --- |
| Adoption and author workflow | Private drafts, package intake, history, author feedback, docs/site onboarding | First AUTHOR-1 and HOST-1 slices; supported user and operator journeys |
| Agent use | MCP audit/compatibility, architecture projections, platform adapters | First MCP-1 host and delivery contract; relation to connected management |
| Quality and discovery | Evals, scan jobs, search, review evidence | REC-1 experiment versus durable eval and scanning priorities |
| Identity and governance | Provider lifecycle, CLI device login, organization controls | Remaining business self-hosting requirements and their release gates |
| Operations and distribution | Container publishing, backups, recovery, monitoring, release automation | HOST-1 packaging choice, support matrix, and fresh-install proof |
| Broader connected management | Cross-tool sync, full architecture execution, optional telemetry | Keep, defer, or narrow based on demand and current Codex evidence |

For each selected slice, agree the user outcome, dependencies, smallest deliverable,
acceptance evidence, owner, effort range, release target, and explicit deferrals.
Dates and implementation commitments follow that review.

## Future Product Expansion

These items are intentionally downstream from the public beta and production-hardening work. They are strategic product directions, not public-beta blockers.

### Connected Skills Management

Goal: let users connect their AI tools and systems to MySkills for clean, user-controlled, bi-directional skills management across apps, machines, and projects.

Depends on: Milestones 4, 5, 7, 7A-7E, and the platform-install-adapter work
in Milestone 9. The operational beta adds a governed Codex workspace companion
to the Phase 2 foundations. Broader bi-directional, multi-tool management and full
architecture execution are not established by that single supported path.

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
