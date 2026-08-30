# ADR 0004: Skill Architecture Control Plane

Version: 0.1.0
Last updated: 2026-08-30

## Status

Accepted for the MVE implementation. The implementation contract is in
[Skill Architecture Control Plane](../SKILL_ARCHITECTURE_CONTROL_PLANE.md).

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

1. Store an owner-private draft shell and bounded, immutable `ArchitectureSpecV1`
   revisions in Postgres. Each skill reference carries a slug, semantic
   version, and SHA-256 digest. Before an effective preview is returned, the
   API binds each reference to one exact server-authorized registry release;
   it does not copy package bytes or accept client visibility claims.
2. Represent topology explicitly as typed router and leaf nodes with declared
   child edges. Validate `flat`, `domain-router`, and nested
   `multi-level-router` patterns deterministically. Reject cycles, orphans,
   illegal edges, duplicate IDs, unavailable releases, and digest mismatches.
3. Keep package discovery visibility, architecture ownership, and runtime
   exposure as separate policy decisions. The effective profile compiler
   defaults to deny, explicit denials override allows, and environment names
   do not imply an organization or team permission. Organization-scoped
   visibility is unsupported until organization tenancy exists.
4. Derive one consolidated preview from the revision. The profile-filtered
   compilation, positioned graph/SVG or Mermaid projection, and accessible
   outline must share the same selected node set. Fixture-backed dry-run sync
   plans are also derived outputs; diagrams and observed target state are not
   writable sources of truth.
5. Use the existing API session/token and Postgres boundaries. Read projections
   require the explicit `architectures:read` scope. Create and revision append
   are session-only. Do not introduce a new login path, client-trusted
   visibility claim, target credential store, or silent target write in this
   slice.
6. Keep live adapters/apply/rollback, team-owned architectures, organization
   tenancy, conditional exposure evaluation, and a required React Flow canvas
   as later decisions.

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

Add architecture tables with a new append-only migration. Existing registry and
sharing rows remain unchanged. If deployment validation fails, stop at the
failed migration and repair forward or restore the pre-migration database using
the deployment runbook. Do not delete architecture or registry data as an
ad-hoc rollback. Capability discovery lets older clients continue without
architecture support.

## Verification

Acceptance requires deterministic core/compiler tests, API/Postgres
authorization and immutability tests, explicit `architectures:read` versus
session-only write tests, exact release/digest binding tests, consolidated
preview graph/outline parity, diagram escaping, strict metadata-only fixture
sync-plan tests, browser accessibility coverage, privacy scans, and the
repository and disposable Postgres gates on a supported runtime.
