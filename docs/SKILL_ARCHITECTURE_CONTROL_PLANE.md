# Skill Architecture Control Plane

Version: 0.2.0-draft
Last updated: 2026-09-01
Status: Phase 2 implementation slices in the current branch; not a released or live-deployment contract

## Purpose and goal

MySkills is the canonical control plane for reviewed skill releases and the
desired arrangements in which those releases are used. The broader product
goal is to let an individual or team discover, govern, version, share,
compose, inspect, and safely update skills across personal, work, team, and
organization contexts. A destination-specific directory, provider UI, local
configuration file, or visual canvas is not the source of truth.

The goal of this Phase 2 work is to make that control plane useful for the
multi-level router/leaf architectures used by Codex-like environments while
keeping authority, privacy, and rollout boundaries explicit. The current
branch therefore adds or specifies:

- selectable `flat`, `domain-router`, and `multi-level-router` topology
  patterns;
- immutable architecture shells and revisions with exact release digests;
- user/team ownership, organization policy and sharing foundations, and
  effective child-team membership;
- profile and environment selection with fail-closed exposure rules;
- editor, diagram, and accessible outline projections derived from one
  compilation;
- connected-target identity, consent, capability, health, and metadata-only
  observation records;
- fixture-only sync planning, recovery, leases, fencing, and audit evidence;
- a pure derive-shell pattern migration contract; and
- explicit API, web, CLI, and MCP boundaries.

The API and Postgres remain canonical. Core contracts are framework-neutral.
Web, CLI, MCP, diagrams, adapters, and fixtures are clients or derived
evidence. The documented Phase 1 beta Railway baseline is separate; this
document does not claim that Phase 2 is deployed there.

## Evidence language

- **Implemented:** present in the current branch and covered by focused code
  or contract tests. This does not mean it is exposed on every client or that
  the release gate has passed.
- **Schema foundation:** migration and database constraints exist, but a
  service or route may still be absent.
- **Deferred:** intentionally not implemented in this slice. It must not be
  described as available to users.
- **Live-readback:** confirmed against a deployed runtime. No Phase 2
  live-readback is claimed here; source and test presence are not deployment
  evidence.

## Canonical boundaries

The registry owns skill release lifecycle, review, security, publication,
artifact integrity, and package visibility. An architecture stores desired
placement and exact `slug`/`version`/SHA-256 references; it does not copy
package bytes or grant registry access. A preview resolves each reference
through current server policy and fails closed if the exact release is no
longer available. It never substitutes `latest`.

An architecture is a desired logical state. A connected target is a separate
physical integration boundary. An observation is metadata-only evidence about
that boundary, not proof that MySkills changed it. A fixture plan is a review
input, not an apply command.

## Topology and delivery axes

Topology and delivery/governance are separate axes:

| Axis | Current values | Meaning |
| --- | --- | --- |
| Topology pattern | `flat`, `domain-router`, `multi-level-router` | How routers and leaf skills route requests inside one architecture. |
| Delivery/governance mode | API/web/CLI/MCP projections, guided export, connected-target observation, future managed adapter | How a release or architecture is distributed, governed, or observed at a destination. |

Changing a delivery mode must not silently change topology. Changing a
topology pattern must not silently change ownership, grants, target bindings,
or registry release identity. Provider-specific capabilities remain separate
from the architecture pattern; see [AI platform integration boundaries](AI_PLATFORM_INTEGRATIONS.md).

## Architecture model

`ArchitectureSpecV1` is the shared desired-state contract. It contains:

- a server-owned architecture `id`, name, description, and immutable selected
  pattern descriptor;
- normalized exact skill release references, including `id`, `slug`,
  semantic `version`, SHA-256 `digest`, and `packageVisibility`;
- typed `router` and `leaf` nodes and `contains`/`routes` edges;
- entry nodes, logical profiles, and logical environments; and
- profile bindings with `disabled`, `router`, or `leaf` runtime exposure.

The validator rejects unknown fields, duplicate IDs, invalid edges, cycles,
orphans, invalid pattern topology, oversized input, and malformed digests.
`contains` targets a router; `routes` targets a leaf. Profiles default to
`disabled`, and an explicit denial wins over an allow. `personal`, `work`, and
`team` are context labels until a store-resolved tenancy relationship proves
otherwise.

The three built-in patterns are:

| Pattern | Required topology |
| --- | --- |
| `flat` | Leaf nodes only; no edges; every leaf is an entry. |
| `domain-router` | One router entry with `routes` edges to leaves. |
| `multi-level-router` | At least one router-to-router `contains` edge and a router-to-leaf `routes` path. |

### Immutable revisions and editor

`skill_architectures` stores a stable shell and current-revision pointer.
`skill_architecture_revisions` stores normalized immutable specs and a
monotonic revision number. The API injects authoritative shell identity and
pattern metadata before persistence. An append can carry
`expectedCurrentRevisionId`; a stale current pointer returns a conflict rather
than overwriting another edit.

The web editor is an implemented semantic workbench for the current/latest
revision. It supports bounded graph edits, registry release lookup, profile
and environment context, a controlled React Flow projection, deterministic
layout, accessible outline, preview, save, and conflict-preserving reset.
The canvas is presentation data and never the source of truth. Revision list,
immutable history/diff views, “use as new draft”, and the first-revision exact
release-picker flow are implemented as derived web controls.

### Pattern migration

`deriveArchitecturePatternMigration` is a pure core contract with mode
`derive-shell`. It supports every pair among the three built-in patterns. A
bounded mapping may select a root, label, router groups, parent routers, and a
deterministic fallback for unassigned leaves. The result preserves exact
normalized skills/releases and rewrites profile/environment bindings so leaf
exposure is preserved. Invalid source, target, mapping, limit, or exposure
conditions return `mappingStatus: "blocked"` and `target: null`.

Migration never mutates the source revision or rebinds a target. The successful
candidate retains the source shell fields only as a placeholder; the API
service allocates a new shell identity, authorizes exact releases, appends the
first revision, and recomputes digests. Migration 0020 records source/target
revision lineage, mapping/diff status, digests, and idempotency constraints;
the local API exposes preview/create routes and the web workbench exposes the
same preview-first controls. The injected external release-authorizer
preflight cannot be atomic with the database transaction.

## Tenancy, organizations, and effective membership

Architecture ownership is explicit: `owner: { type: "user" | "team", id }`.
The Phase 2A policy version has roles `owner` and `member`, with actions
`read`, `preview`, `create`, `append-revision`, and `manage-policy`. User
owners and team owners can write; team members can read and preview only.
Memberships are resolved by the store on every decision. Caller-supplied team
IDs are not authority.

Migration 0016 preserves existing standalone teams while adding the nullable
team owner path. A child team is effective for an actor only when its parent
organization is active, has a current policy revision, and the actor has an
active membership in that same organization. A raw team membership never
substitutes for organization membership. The organization policy controls
whether team members must be organization members; the default is fail-closed
(`requireOrganizationMembershipForTeamMembers: true`). Standalone teams keep
their pre-tenancy behavior when `teams.organization_id` is null.

Organizations use statuses `provisioning`, `active`, `suspended`, and
`archived`, and membership roles `owner`, `admin`, and `member`. Policy v1 is
stored as an immutable, canonical JSON revision with a SHA-256 digest. Policy
contains sharing flags, team rules, and bounded quotas. Organization skill and
architecture grants are bound to a policy revision and organization identity;
architecture grants are `read` only to receiving members. Manager-only GET/PUT
routes and web controls replace the complete grant set with current-revision,
policy, membership, exact-release, limit, and sanitized-audit checks; an empty
set revokes all grants.

The v1 default policy enables organization skill and architecture sharing but
does not let ordinary members share owned skills or team owners share
architectures to a parent organization. It disallows member-created teams,
requires organization membership for members of parented teams, allows
standalone-team adoption, and limits each organization to 100 teams, 1,000
members, 25 skill grants, and 25 architecture grants. A later policy revision
may change these values within the validator bounds.

The API and stores implement organization membership, invitations, lifecycle,
policy revisions, team adoption, and current-policy checks. Architecture
organization read/preview foundations resolve active membership, organization
status, current policy, exact grant, and the instance sharing switch. An
organization-visible architecture revision is returned only when its release
references are safe for the organization projection (`public`, `authenticated`,
or `organization`). Private, team-scoped, and explicit-user references are
excluded. Organization-only readers receive safe summaries, must select an
authorized organization context for preview, and do not receive raw revision
payloads. The architecture-grant GET/PUT route and manager-only web control are
policy-gated, current-revision guarded, atomic in Postgres, and audited.

## Connected environments and targets

Logical environments and profiles live in the architecture spec. A connected
target is a separate record in `skill_architecture_targets` with:

- one explicit user, team, or organization owner;
- architecture, environment, and profile binding;
- adapter kind/version/contract, identity digest, status, consent, and a
  monotonic generation;
- read capabilities `inventory.read`, `health.read`, and `plan.read`; and
- bounded scalar metadata and an opaque credential-store reference that is
  never returned in the public record.

Target statuses are `connected`, `degraded`, and `revoked`. Consent is
`pending`, `granted`, `denied`, or `revoked`. Observations are append-only and
bind the target generation, adapter digest, and capability digest. They carry
skill metadata, finding codes/counts, health, and redacted prompt-awareness
booleans/counts. They never carry package bytes, prompt text, configuration
values, credentials, URLs, endpoints, or local paths.

The core adapter interface is deliberately read-only: `observe(context)` and
`health(context)`. Mutation capability names (`apply`, `rollback`, and
`sync.write`) must be absent or false. Target registration, consent,
observation, health, and revoke API routes exist; an adapter is not invoked by
those routes automatically.

### Codex privacy boundary

The CLI includes a fixture-tested Codex read-only adapter. It
accepts an explicit caller-supplied root and profile, reads only bounded
profile/router metadata and safe `SKILL.md` frontmatter, and returns
deterministic metadata observations. It does not search a home directory,
follow profile pointers, read prompt bodies, emit paths or URLs, retain
credentials, upload data, or expose mutation methods. The
`architectures observe` and `architectures health` commands run this adapter
locally. Live API target upload, automatic discovery, and write operations are
deferred.

## Diagram and accessible artifacts

The compiler produces one authorized effective node set. The API returns a
positioned graph and escaped Mermaid projection. The browser derives a
deterministic SVG from that graph and renders a matching accessible outline
and table. The SVG uses a labelled `role="img"` with title/description; the
outline remains usable without a canvas. Labels are escaped and unauthorized
nodes, package content, paths, credentials, and private inventories are not
included.

These graph, Mermaid, SVG, and outline values are derived artifacts. They are
useful for inspection, copying, background review, and browser download of
diagram JSON/Mermaid plus plain-outline display, but they are not a second
source of truth.
Durable server-side diagram storage, versioned layout annotations, and an
editable visual artifact format remain deferred.

## Fixture-only sync and recovery

The architecture core defines deterministic desired-vs-observed actions such
as `noop`, `install`, `update`, `downgrade`, `enable`, `disable`, `remove`,
`conflict`, `unsupported`, and `configure-router`. Fixture input is bounded
metadata only; paths, package content, credentials, unknown fields, and
implicit targets are rejected. Plans always declare `dryRun: true`,
`canApply: false`, and `requiresApproval: true`.

Migration 0019 adds append-only sync runs, steps, baselines, receipts,
recovery evidence, target leases, fencing tokens, digests, and safe metadata.
The API-side `ArchitectureSyncService`, in-memory fixture executor, and
Postgres store persist and exercise approval, synthetic apply/verify/rollback
state transitions, recovery decisions, lease loss, and idempotency for tests.
This does not mutate a target. No public sync-run route, live adapter
executor, package installer, filesystem writer, or live apply/rollback path is
enabled. Each bounded sync run allows at most 500 steps and 2,004 append-only
receipts. That capacity covers a 1,002-receipt max-step lifecycle, one full
apply/verify retry, and two recovery/terminal receipts; further retries require
a new bounded run.

## API and client parity

| Surface | Current branch capability | Explicit gap |
| --- | --- | --- |
| API | Architecture patterns/list/detail/revision/preview and draft-preview; organization membership/policy/team routes; atomic architecture-grant GET/PUT; pattern-migration preview/create; target registration/consent/observation/health/revoke. | No public sync-run route or live target operation. |
| Web | Architecture dashboard, semantic editor, exact-release selection, immutable revision history/diff, “use as new draft,” profile/environment preview, SVG plus JSON/Mermaid downloads and a plain-outline projection, user-supplied fixture dry run, organization management, manager grant save/revoke, pattern-migration preview/create, and connected-target workbench. | CLI/MCP write parity, public sync-run UI, live adapters, and durable server-side diagram artifacts. |
| CLI | Read-only `architectures patterns`, `list`, `show`, `preview`, `compile`, `plan`, and `dry-run`, plus local explicit-root `architectures observe` and `architectures health`; skill-sharing commands include organization grants. | No architecture organization-grant/target/sync/migration API commands and no live Codex upload or mutation connector. |
| MCP | Read-only `list_architecture_patterns`, `list_architectures`, and `get_architecture_projection`, plus registry discovery tools. | No architecture writes, organization/target/sync/migration tools, or target mutation. |

API authorization is the source of truth. Web, CLI, and MCP do not recreate
membership, release, organization, consent, or target policy. The current
parity is intentionally asymmetric: API/web provide architecture editing,
API provides tenancy and target lifecycle, and CLI/MCP provide safe reads.

## Migration sequence

Run migrations in lexical order. After a release, migration files are
append-only:

| Migration | Current purpose |
| --- | --- |
| `0015_skill_architectures.sql` | Base architecture shells, immutable revisions, pattern and current-revision constraints. |
| `0016_architecture_owner_tenancy.sql` | User/team owner columns, exactly-one-owner check, and architecture policy version. |
| `0017_organizations_and_org_sharing.sql` | Organization lifecycle, immutable policy revisions, memberships/invitations, nullable team parentage, and policy-bound skill/architecture grants. No team backfill. |
| `0018_architecture_targets_and_observations.sql` | Target owner/binding, consent, capability, generation, health, and append-only metadata observations. |
| `0019_architecture_sync_control.sql` | Fixture-only sync control tables, leases, fencing, baselines, receipts, and recovery evidence. |
| `0020_architecture_pattern_migrations.sql` | Append-only derive-shell lineage, mapping/diff safety checks, revision digests, and idempotency constraints. |

The current branch contains 0020, its local migration service, Postgres
transaction, API routes, and web controls. A migration file or local route is
not evidence that Phase 2 is deployed or that live target operations are
enabled; fresh disposable-Postgres and supported-runtime verification is still
required.

Before production applies migration 0019, the operator must verify a restorable
database backup and the backup-restore procedure, record the accepted data-loss
boundary, and assess and approve the expected Postgres lock window for its
`ALTER TABLE`, constraint, type, function, and table operations. A local pass or
backup artifact alone does not establish either gate; if either is unapproved,
stop before 0019 and use the deployment runbook's repair-forward or
pre-migration restore path.

## Deferred and non-goals

This Phase 2 slice does not enable:

- live Codex, ChatGPT, Claude, filesystem, API-project, or other target
  adapters;
- target writes, package installation, apply, rollback, or credential
  management;
- automatic discovery of local homes, profiles, paths, prompts, or config
  contents;
- public architecture publishing, provider-derived roles, or conditional
  runtime policy evaluation;
- CLI/MCP write parity for architecture organization-grant, target, sync, or
  migration operations;
- public sync-run routes, live adapters, target writes, package installation,
  apply, rollback, or credential handling; or
- durable server-side diagram artifacts, versioned layout, or layout as
  canonical data.

See [DATA_MODEL.md](DATA_MODEL.md), [API_MCP_CLI_PLAN.md](API_MCP_CLI_PLAN.md),
[SECURITY_MODEL.md](SECURITY_MODEL.md), and [THREAT_MODEL.md](THREAT_MODEL.md)
for persistence, route, and release-gate details.

## Verification boundary

Focused core, API, migration, target, sync, web, CLI, MCP, and browser test
suites are part of the current branch work. A clean supported-runtime
repository release gate, disposable-Postgres run, browser/UAT review, and
independent security review are still required before a Phase 2 release. Any
final claim must distinguish source/test evidence from a live Railway
read-back and must not present fixture behavior as connected-target behavior.
