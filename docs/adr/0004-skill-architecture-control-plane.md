# ADR 0004: Skill Architecture Control Plane

Version: 0.1.0
Last updated: 2026-09-01

## Status

Accepted for the MVE implementation. The MVE boundary recorded below is a
historical baseline that is expanded by the current local Phase 2 branch; see
the [current Phase 2 scope](#current-phase-2-scope). The implementation
contract is in [Skill Architecture Control Plane](../SKILL_ARCHITECTURE_CONTROL_PLANE.md).

## Context

The beta registry manages individual skill packages, releases, lifecycle, and
sharing. That model does not yet express how a user or team chooses a set of
skills for a runtime, how nested routers select leaves, or how a desired
configuration should be compared with a target without silently changing it.
The architecture record therefore starts as an owner-private draft shell and
gains immutable revisions as graphs are saved.

The reference patterns in
[`jremick/skill-library-reference-architecture`](https://github.com/jremick/skill-library-reference-architecture)
show useful progressive-disclosure levels, but MySkills needs an explicit
versioned graph and API-owned authorization. A folder layout, a visual canvas,
or a target machine cannot be the canonical source because each can be stale,
partially visible, or difficult to audit.

## Decision

Add a Skill Architecture Control Plane with these rules:

1. Store an owner-scoped shell and bounded, immutable `ArchitectureSpecV1`
   revisions in Postgres. User/team ownership is the default boundary;
   manager-authorized organization grants can add read/preview access without
   changing ownership. Each skill reference carries a slug, semantic version,
   and SHA-256 digest. Before an effective preview is returned, the API binds
   each reference to one exact server-authorized registry release; it does not
   copy package bytes or accept client visibility claims.
2. Represent topology explicitly as typed router and leaf nodes with declared
   child edges. Validate `flat`, `domain-router`, and nested
   `multi-level-router` patterns deterministically. Reject cycles, orphans,
   illegal edges, duplicate IDs, unavailable releases, and digest mismatches.
3. Keep package discovery visibility, architecture ownership, and runtime
   exposure as separate policy decisions. The effective profile compiler
   defaults to deny, explicit denials override allows, and environment names
   do not imply an organization or team permission. The original MVE did not
   support organization-scoped visibility; the current local Phase 2 extension
   evaluates it through organization status, policy, active membership, and
   explicit grants.
4. Derive one consolidated preview from the revision. The profile-filtered
   compilation, positioned graph/Mermaid projection, browser SVG, diagram JSON,
   and accessible outline must share the same selected node set.
   Fixture-backed dry-run sync plans are also derived outputs; diagrams and
   observed target state are not writable sources of truth.
5. Use the existing API session/token and Postgres boundaries. Read projections
   require the explicit `architectures:read` scope. Create, revision append,
   organization-grant replacement, and pattern-migration create are
   session-only; privileged/team-owner mutations require MFA. Do not
   introduce a new login path, client-trusted visibility claim, target
   credential store, or silent target write in this slice.
6. Keep live adapters, target apply/rollback, target writes, package
   installation, and conditional exposure evaluation as later decisions. The
   Phase 2 source release includes team-owned architectures, organization
   tenancy, and a React Flow editor, but this does not imply a hosted
   deployment.

## Current Phase 2 scope

This section records the local expansion without rewriting the accepted MVE
decisions above:

- Team and organization tenancy foundations now exist locally. Organization
  membership, policy, and organization-scoped visibility are represented and
  evaluated by API contracts. Manager-only architecture-grant GET/PUT routes
  replace complete sets atomically with current-revision, policy,
  membership, exact-release, limit, and audit checks; the web workbench
  exposes save and revoke-all controls. CLI organization skill-sharing writes
  are available through the existing sharing command, while architecture
  organization-grant writes remain deferred in CLI/MCP.
- Derive-shell pattern migration now has a bounded preview service, an
  owner/team-owner MFA-protected create route, atomic Postgres shell/revision/
  lineage persistence, idempotent replay, and matching web controls. The
  source shell, grants, and target bindings are not copied. The injected exact
  release authorizer remains a preflight outside the database transaction.
- The API returns a versioned diagram artifact; the web workbench derives
  accessible SVG and allows JSON/Mermaid/plain-outline download from the same
  authorized graph. Durable server-side diagram storage remains deferred.
- Target and organization web workbenches expose the local tenancy, consent,
  health, safe-observation, and binding controls described by the target
  records.
- `myskills architectures observe` and `myskills architectures health` run a
  read-only Codex adapter against an explicitly supplied absolute root and
  profile. They emit bounded metadata and health evidence; they do not
  discover profiles, upload observations, or modify a target.
- Sync and recovery control exists as bounded, fixture-only planning with
  in-memory and persisted Postgres service/store evidence. Recovery and
  rollback transitions are persisted and covered by focused tests; a fresh
  release-gate run is still required. No public sync route, live adapter
  executor, target apply, target rollback, package installer, or filesystem
  writer is enabled for architecture targets. Each bounded run allows at most
  500 steps and 2,004 append-only receipts: a 1,002-receipt max-step lifecycle,
  one full apply/verify retry, and two recovery/terminal receipts. Further
  retries require a new bounded run.

The original MVE's organization and team-tenancy exclusions are superseded by
this local expansion. The no-live-write and no-credential-store boundaries
remain current. The documented Phase 1 Railway baseline is separate and
requires live read-back; this Phase 2 branch is local and has not been
deployed there.

## Consequences

Positive consequences:

- Nested router-to-router-to-leaf designs can be represented without encoding
  topology in labels or directory names.
- A digest-attested revision can be reviewed and compared across profile
  contexts without mutating a connected tool.
- One deterministic compiler can support API, web, CLI, diagrams, and future
  adapters while preserving route-level authorization.
- An outline/tree keeps the architecture usable for keyboard, screen-reader,
  export, and no-canvas contexts.

Costs and constraints:

- The schema and graph validator are a new compatibility contract that must be
  versioned instead of casually changing in place.
- Every referenced release must pass the current server-side visibility and
  lifecycle checks before a preview; an old revision may become temporarily
  un-previewable when a release is revoked, deleted, or becomes inaccessible.
- A useful connected-tool experience still requires later target identity,
  consent, capability negotiation, conflict handling, audit, and rollback
  design.
- The MVE adds Postgres migration and cross-surface tests without claiming that
  it can manage a live Codex personal or work environment.

## Alternatives rejected

- **Use the package directory as the architecture.** This cannot express
  profile/environment policy, exact revision identity, or reviewable sync.
- **Make the diagram/canvas canonical.** Visual state is difficult to validate,
  inaccessible when rendered, and vulnerable to accidental or unauthorized
  edits.
- **Store only a flat list of skills.** This loses nested routing and prevents
  explicit router-level exposure rules.
- **Treat package visibility as runtime enablement.** A release can be
  authorized for discovery but intentionally disabled in a profile; combining
  the states would create both privacy and placement errors.
- **Connect to local environments during the MVE.** A live adapter would add
  credentials, destructive writes, rollback expectations, and per-tool
  capability decisions before the desired-state contract is proven.

## Migration and rollback

The local Phase 2 branch adds architecture tables with append-only migrations
0015–0020 in lexical order. Existing registry and sharing rows remain
unchanged. Any future deployment must validate each migration before moving to
the next; if validation fails, stop at the failed migration and repair forward
or restore the pre-migration database using the deployment runbook. Do not
delete architecture or registry data as an ad-hoc rollback. Capability
discovery lets older clients continue without Phase 2 support; the current
branch's local routes do not make the Phase 2 branch hosted or live.

Before a production deployment applies migration 0019, operators must verify a
restorable database backup and the backup-restore procedure, record the
accepted data-loss boundary, and assess and approve the expected Postgres lock
window for the migration's `ALTER TABLE`, constraint, type, function, and table
operations. A local migration pass or backup artifact alone is not evidence of
either gate. If either gate is not approved, stop before 0019 and use the
deployment runbook's repair-forward or pre-migration restore path.

## Verification

Acceptance for a future Phase 2 release requires deterministic core/compiler
tests, API/Postgres authorization and immutability tests, explicit
`architectures:read` versus session-only write tests, exact release/digest
binding tests, organization grant atomic replacement and stale-revision tests,
pattern-migration preview/create/idempotency/lineage tests, consolidated
preview graph/diagram/outline parity, diagram escaping, strict metadata-only
fixture sync-plan and persisted recovery/rollback tests, browser accessibility
coverage, privacy scans, and the repository and disposable Postgres gates on a
supported runtime. The current source/test inventory is not a passing-gate or
hosted-readback claim; live target/provider behavior remains outside this ADR.
