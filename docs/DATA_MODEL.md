# Data Model

Version: 0.1.0-beta.3
Document revision: 0.2.0-draft
Last updated: 2026-09-01

Postgres is the canonical application store. This document describes the
current branch schema and separates database foundations from routes, services,
client surfaces, and live capabilities that are still deferred.
The Phase 2 tables and services described here are source-release evidence;
they are not a deployed Railway schema or live provider integration.

## Implemented identity and access tables

- `users`: primary users with normalized email uniqueness, status, and
  verification state.
- `password_credentials`: password hashes for first-party accounts.
- `auth_sessions`: hashed opaque sessions with MFA and revocation state.
- `auth_action_tokens`: hashed, expiring, single-use email verification,
  password reset, invitation, and email-change actions.
- `mfa_factors`, `mfa_recovery_codes`, `mfa_challenges`: TOTP enrollment,
  recovery, and challenge state.
- `api_tokens`: scoped, hashed CLI/automation/MCP tokens with display prefix,
  expiry, revocation, and use tracking.
- `roles`, `role_assignments`: instance-level role definitions and assignments.
- `auth_rate_limits`: durable authentication rate-limit buckets.
- `provider_configs`, `provider_role_mappings`: non-secret provider metadata
  and bounded claim-to-local-role mappings. Provider login/linking remains
  planned.

## Implemented registry and artifact tables

- `skills`: stable slug, title, summary, owner, visibility, sharing posture,
  and lifecycle.
- `skill_versions`: semantic version, release notes, review/security/lifecycle
  state, approval hash, publication state, and soft deletion.
- `skill_platform_variants`: target runtime/install metadata for a skill version.
- `skill_artifacts`: opaque storage reference, content type, byte size, SHA-256,
  and development-only normalized payload fallback.
- `artifact_write_intents`: recovery state for object writes that must be
  reconciled with the database.
- `skill_tags`: searchable taxonomy.
- `scan_runs`, `scan_findings`: package validation and risk-scan status/evidence.

## Teams, organizations, and sharing

- `teams`, `team_memberships`: team identity and member roles. `teams.organization_id`
  is nullable so existing standalone teams remain valid; migration 0017 does
  not backfill them.
- `team_invitations`: invitation state for team membership.
- `organizations`: organization identity, slug, lifecycle status, current policy
  pointer, creator, and timestamps. Status is
  `provisioning|active|suspended|archived`; an active organization requires a
  current policy revision.
- `organization_policy_revisions`: immutable schema-v1 canonical policy,
  SHA-256 digest, reason, monotonic revision number, creator, and timestamps.
  The policy contains sharing flags, team rules, and bounded quotas. Defaults
  enable organization skill/architecture sharing, disable member-owned-skill
  and team-owner parent sharing, disallow member-created teams, require
  organization membership for parented-team members, allow standalone-team
  adoption, and limit organizations to 100 teams, 1,000 members, 25 skill
  grants, and 25 architecture grants.
- `organization_memberships`: organization/user role (`owner|admin|member`) and
  removal timestamp. Active membership is the only membership form used by
  policy evaluators.
- `organization_invitations`: normalized recipient, role, lifecycle status,
  acceptance, and pending-invitation uniqueness.
- `skill_team_grants`, `skill_user_grants`, and `skill_organization_grants`:
  explicit release-sharing grants. Organization skill grants are bound to the
  organization and the policy revision under which they were created.
- `skill_architecture_organization_grants`: architecture organization grants
  with `access_level = 'read'`, organization identity, creator, and the policy
  revision under which the grant was created. The API exposes manager-only
  GET/PUT complete-set replacement with current-revision concurrency, policy,
  membership, exact-release, limit, and sanitized-audit checks; the
  architecture web workbench uses this route for save and revoke-all.
- `instance_settings`: instance-level registration and sharing controls.

The effective child-team rule is derived, not stored as a copied membership:
when `teams.organization_id` is non-null, a team membership is effective only
if the parent organization is active, has a current policy, and the user has
an active membership in that same organization. A raw team membership cannot
substitute for organization membership. Standalone teams retain their legacy
behavior.

## Skill Architecture Control Plane

The architecture model is separate from registry release records. It stores
desired topology and exact release references; it does not copy package bytes
or turn package visibility into runtime placement.

### Base architecture records

- `skill_architectures` (migration 0015, extended by 0016): stable shell ID,
  `owner_user_id` or `owner_team_id` (exactly one), `access_policy_version`,
  name, description, immutable selected `pattern_id`, current revision pointer,
  and timestamps.
- `skill_architecture_revisions` (0015): immutable architecture/revision ID,
  monotonic `revision_number`, message, normalized `ArchitectureSpecV1` JSONB,
  creator, and timestamp. The current branch computes a canonical revision
  digest in core; 0015 does not add a separate digest column.
- Profiles and environments remain embedded in the canonical spec. They are
  logical context records, not independent tenancy rows.
- A revision contains typed router/leaf nodes, edges, exact `slug`/semantic
  `version`/SHA-256 release references, profile bindings, and environments.
  The API re-resolves those references against current server-owned release
  policy before returning a preview.

For an organization-only reader, unsafe revisions are withheld from the raw
revision projection. A preview must name an authorized organization context;
the API then resolves the exact release set for that organization. Package
visibility values that are private, team-scoped, or explicit-user are not
included in an organization-safe revision projection.

### Pattern migration lineage

- `skill_architecture_pattern_migrations` (0020): append-only derive-shell
  lineage. It records source and target architecture/revision IDs and pattern
  IDs, source/target revision digests, `mapping_status`, bounded `mapping` and
  `diff` JSONB, `migration_digest`, `diff_digest`, actor, idempotency key, and
  timestamp.
- Composite foreign keys bind each revision to its architecture. Checks limit
  patterns, mapping/diff metadata, SHA-256 digests, and idempotency keys.
  Target architecture and target revision are unique to prevent duplicate
  lineage.

The shared core derives a candidate for every pair of `flat`, `domain-router`,
and `multi-level-router`. It preserves normalized skill/release references and
leaf exposure bindings, and fails closed on invalid mapping or exposure
mismatch. The API service and Postgres store create the new shell, first
immutable revision, and lineage in one transaction. The owner/team-owner
routes are preview-first and idempotent; grants and connected targets are not
copied. The injected exact-release authorizer runs as a service preflight, so
its external state cannot be made atomic with the database transaction.

### Connected targets and observations

- `skill_architecture_targets` (0018): one explicit user/team/organization
  owner; architecture/environment/profile binding; adapter kind, contract and
  version; `connected|degraded|revoked` status; consent timestamps and
  `pending|granted|denied|revoked` status; capability JSONB and digest;
  identity digest; monotonic generation; safe metadata and health summary; an
  opaque `credential_reference` that is store-only and never public.
- `skill_architecture_observations` (0018): append-only target/generation
  evidence with adapter and capability digests, observed digest, bounded
  metadata-only observed state, counts, health summary, capture time, and
  immutable triggers. It does not hold package content, prompts, paths,
  endpoints, URLs, or credential values.

The v1 capability allowlist is `inventory.read`, `health.read`, and `plan.read`.
Mutation names `apply`, `rollback`, and `sync.write` may be present only as
false values. Target and observation rows do not prove that a destination was
changed.

### Fixture-only sync control

Migration 0019 adds the sync journal and tenant-scoped integrity constraints:

- `skill_architecture_sync_runs`: run/revision/target/generation/snapshot
  bindings, desired/compiled/observed/plan digests, approval and baseline
  digests, status/failure fields, bounded counters and safe metadata, request
  and idempotency keys.
- `skill_architecture_sync_steps`: ordered desired actions and state
  transitions, with immutable identity and digest fields.
- target leases and fencing records; baselines; append-only receipts; and
  recovery evidence.

Run and step enums distinguish drafted, approval, lease, revalidation,
preparation, synthetic apply, verification, blocked, failure, rollback, and
recovery states. Composite foreign keys prevent a revision, target, generation,
or observed snapshot from being mixed across architectures. The core service,
in-memory fixture executor, and Postgres store persist and validate the
fixture-only journal, recovery, rollback, lease, fencing, and idempotency
evidence. There is no live executor, package installer, filesystem writer, or
public sync-run route. Each bounded sync run allows at most 500 steps and 2,004
append-only receipts. That capacity covers a 1,002-receipt max-step lifecycle,
one full apply/verify retry, and two recovery/terminal receipts; further retries
require a new bounded run.

Before a production deployment applies migration 0019, the operator must take
and verify a restorable database backup, rehearse or otherwise verify the
backup-restore path, record the accepted data-loss boundary, and assess the
expected Postgres lock window for the `ALTER TABLE`, constraint, type, function,
and table work in that migration. A backup file or local migration pass is not
evidence of restore readiness or an approved lock window. If either gate is not
approved, stop before applying 0019; repair forward or restore the pre-migration
database through the deployment runbook rather than deleting application rows.

### Derived projections and diagrams

The compiler derives the effective graph, positioned graph, Mermaid, and
accessible outline data. The API also returns a versioned diagram artifact with
a Mermaid content hash and an artifact digest bound to the plain outline. The
browser derives SVG and renders the matching outline/table from the same
filtered node set; downloadable diagram JSON and Mermaid text are derived
artifacts. These are not persisted canonical state; durable server-side diagram
storage, versioned layout data, and an editable visual artifact remain planned.

## Implemented operations tables

- `audit_events`: sanitized security and lifecycle decisions.
- `jobs`: schema groundwork for durable background work. The beta does not yet
  run production background scan/evaluation workers.

Architecture, tenancy, target, and sync service audit records should contain
actor, relationship, revision/digest, target identity, decision, and bounded
counts only. They must not contain package contents, prompt text, local paths,
credentials, or raw target configuration.

## Workflow mapping

Package submission creates or updates a skill and version in review state,
records scan evidence, and writes an immutable artifact. Review actions update
the version's review/lifecycle state and audit trail. Approval stores the
reviewed artifact SHA-256. Publication revalidates that artifact and moves the
version into a public release state without mutating package bytes.

Public release reads require all of the following:

- skill lifecycle is `approved` or `deprecated`;
- skill visibility/sharing allows the request;
- version lifecycle is `approved` or `deprecated`;
- review is approved and security status passed;
- `publishedAt` is present and the version is not deleted; and
- artifact metadata exists and stored bytes match size and SHA-256.

Deprecated releases remain discoverable/installable. Unpublished, revoked,
archived, or deleted skills/versions are hidden from public discovery and
delivery.

## Planned or deferred data concepts

These are not current tables or live capabilities:

- external identity links and provider login/linking state;
- private draft workspaces separate from submitted versions;
- structured review comment threads and standalone lifecycle-event projections;
- version-aware eval suites, runs, and results;
- install/download analytics and registered MCP clients/tool events;
- queued notification delivery and delivery attempts;
- backup snapshots and restore/recovery metadata beyond the sync evidence
  foundations;
- standalone normalized profile/environment tables or conditional-exposure
  evaluation records;
- CLI/MCP organization-grant and pattern-migration write commands;
- public sync-run routes and live sync service orchestration;
- live target adapters, target writes, apply/rollback, and credential handling;
- integration of the Codex read-only module with target registration and live
  runtime discovery; and
- durable server-side diagram artifact storage, versioned layout data, and an
  editable visual artifact format.

New tables should be added only when their semantics and
retention/authorization policies are defined. Existing migration files are
append-only after release; schema changes use a new ordered migration.
