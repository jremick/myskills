# Data Model

Version: 0.1.0-beta.2
Last updated: 2026-08-30

Postgres is the canonical application store. The sections below distinguish tables present in the beta migrations from product concepts that remain planned.

## Implemented Identity And Access Tables

- `users`: primary users with normalized email uniqueness, status, and verification state.
- `password_credentials`: password hashes for first-party accounts.
- `auth_sessions`: hashed opaque sessions with MFA and revocation state.
- `auth_action_tokens`: hashed, expiring, single-use email verification, password reset, invitation, and email-change actions.
- `mfa_factors`, `mfa_recovery_codes`, `mfa_challenges`: TOTP enrollment, recovery, and challenge state.
- `api_tokens`: scoped, hashed CLI/automation/MCP tokens with display prefix, expiry, revocation, and use tracking.
- `roles`, `role_assignments`: instance-level role definitions and user assignments.
- `auth_rate_limits`: durable authentication rate-limit buckets.
- `provider_configs`, `provider_role_mappings`: non-secret provider metadata and bounded claim-to-local-role mappings. Provider login/linking remains planned.

## Implemented Registry And Artifact Tables

- `skills`: stable slug, title, summary, owner, visibility, sharing posture, and skill lifecycle.
- `skill_versions`: semantic version, release notes, review/security/lifecycle state, approval hash, publication state, and soft deletion. Submission and release workflows currently use this record rather than separate submission/release tables.
- `skill_platform_variants`: target runtime/install metadata for a skill version.
- `skill_artifacts`: opaque storage reference, content type, byte size, SHA-256, and development-only normalized payload fallback.
- `artifact_write_intents`: recovery state for object writes that must be reconciled with the database.
- `skill_tags`: searchable taxonomy.
- `scan_runs`, `scan_findings`: package validation and risk-scan status/evidence.

## Implemented Teams And Sharing Tables

- `teams`, `team_memberships`: team identity and member roles.
- `team_invitations`: invitation state for team membership.
- `skill_team_grants`, `skill_user_grants`: explicit visibility grants layered on the skill's public/authenticated/team/user visibility policy.
- `instance_settings`: registration and instance-level sharing controls.

## Skill Architecture Control Plane (MVE)

The architecture MVE adds a separate desired-state model. It does not replace
the registry tables above or turn package visibility into runtime placement.
An architecture starts as an owner-private draft shell; saving a graph appends
an immutable revision.

- `skill_architectures`: stable architecture identity, owner user, display
  metadata, selected pattern, active-revision pointer, and timestamps. A shell
  may have no revision yet.
- `skill_architecture_revisions`: immutable revision number, bounded canonical
  `ArchitectureSpecV1` JSONB, revision message, creator, and timestamp. The
  compiler returns a deterministic derived digest; the current migration does
  not persist a separate digest column.
- A revision contains explicit router/leaf nodes, exact skill release
  references by slug, semantic version, and SHA-256 digest, logical profiles,
  and logical environments. Profiles and environments are embedded in the
  canonical spec for the MVE; normalized indexes are derived/read-only
  projections if needed.
- The API binds each reference to one server-authorized stable release before
  returning an effective preview. It does not trust client-supplied visibility,
  copy package bytes, change package visibility, or silently select another
  version when a release is unavailable. Organization-scoped visibility is
  unsupported until organization tenancy exists.
- Fixture observed snapshots and dry-run sync plans are request-scoped evidence
  in the MVE. They are not canonical target state and do not require target
  credential or connection tables.
- The consolidated preview's SVG/Mermaid diagram, accessible outline,
  profile-filtered compiled graph, and operation lists are derived outputs.
  They may be cached later, but a cached projection must never become an
  independent writable source of truth.

Architecture revisions are append-only. A user edit creates a new revision; it
does not mutate an earlier spec or derived digest. Team-owned architecture records,
organization tenancy, live target registrations, apply/rollback runs, and
conditional exposure state remain deferred until their authorization and
retention semantics are defined.

## Implemented Operations Tables

- `audit_events`: sanitized security and lifecycle decisions.
- `jobs`: schema groundwork for durable background work. The beta does not yet run production background scan/eval workers.

## Workflow Mapping

Package submission creates or updates a skill and version in review state, records scan evidence, and writes an immutable artifact. Review actions update the version's review/lifecycle state and audit trail. Approval stores the reviewed artifact SHA-256. Publication revalidates that artifact and moves the version into a public release state without mutating package bytes.

Public release reads require all of the following:

- skill lifecycle is `approved` or `deprecated`;
- skill visibility/sharing allows the request;
- version lifecycle is `approved` or `deprecated`;
- review is approved and security status passed;
- `publishedAt` is present and the version is not deleted;
- artifact metadata exists and the stored bytes match size and SHA-256.

Deprecated releases remain discoverable/installable. Unpublished, revoked, archived, or deleted skills/versions are hidden from public discovery and delivery.

## Planned Data Concepts

These are not current tables or live capabilities:

- external identity links and provider login/linking state;
- private draft workspaces separate from submitted versions;
- structured review comment threads and standalone lifecycle-event projections;
- version-aware eval suites, runs, and results;
- install/download analytics and registered MCP clients/tool events;
- queued notification delivery and delivery attempts;
- backup snapshots and restore/recovery metadata;
- storage configuration records beyond deployment environment variables.
- durable connected-target registrations, observed snapshots, sync runs, and
  rollback evidence for live adapters;
- team-owned architecture records and organization tenancy for architecture
  permissions;
- standalone normalized profile/environment tables or conditional-exposure
  evaluation records beyond the MVE's embedded profile rules.

New tables should be added only when their semantics and retention/authorization policies are defined. Existing migration files are append-only after release; schema changes use a new ordered migration.
