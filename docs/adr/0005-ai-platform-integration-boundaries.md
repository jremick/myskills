# ADR 0005: Separate AI Platform Projections And Delivery Boundaries

Version: 0.1.0
Last updated: 2026-09-01

## Status

Proposed. The research and product contract is in
[AI Platform Integration Contract](../AI_PLATFORM_INTEGRATIONS.md). Adoption
requires fixture-backed live validation before any target is marked supported.
The local Phase 2 control-plane additions described below do not promote a
provider target to `pilot` or `supported`. The current branch has generic
registry export/install guidance and metadata-only Phase 2 target/fixture
foundations, but no provider-specific projection or live delivery path.

## Context

MySkills intends to distribute reusable skills to non-technical users of
ChatGPT, Claude, Cowork, and Perplexity, as well as to team and enterprise
administrators. Each provider now has one or more skill-like surfaces, but the
surfaces have different package rules, account scopes, administration models,
and state visibility.

The consumer web applications, managed workspace plugin systems, MCP/app
connectors, and developer API skill resources are not one shared control plane.
For example, a skill created through a developer API is not documented as an
installed skill in the corresponding consumer web organization. A file download
also does not prove that a user uploaded, enabled, or retained it.

MySkills already treats the registry and immutable release artifacts as
application-owned data. Extending the current platform variant field directly
into a universal two-way sync abstraction would hide material differences and
create false state claims.

## Decision

1. Keep the immutable MySkills release as the canonical source. Generate
   provider packages as deterministic, versioned projections with their own
   profile versions and logical content digests.
2. Model a destination as a capability-bearing target such as
   `chatgpt.skill`, `chatgpt.plugin`, `openai-api.skill`, `claude.skill`,
   `claude.plugin`, `anthropic-api.skill`, or
   `perplexity.computer-skill`. Do not use a provider name alone as an adapter
   contract.
3. Separate four delivery classes: guided native export, managed workspace
   publishing, MCP/app runtime connection, and developer API deployment. One
   class cannot supply evidence for another.
4. Separate desired state, artifact handoff, user confirmation, provider
   observation, and runtime verification. Do not label a target installed,
   enabled, or synchronized without evidence and a measured scope.
5. Build the first product slice as export-only guided installation for
   non-technical users. It must not require GitHub, a command line, or a
   provider API credential. The Phase 2 local Codex observe/health commands
   and fixture-only plans are control-plane inspection, not provider
   installation.
6. Add managed publishers and API adapters only after live pilots establish
   package constraints, account scope, consent, conflict behavior, audit,
   readback, retry, and rollback for that exact target.
7. Keep provider credentials outside packages and receipts. Use existing
   MySkills authorization before a private release can be projected or
   disclosed to a provider.
8. Do not use browser automation as a production management interface. It may
   support separately authorized compatibility testing when a documented API
   or connector cannot provide the required observation.

## Consequences

Positive consequences:

- A non-technical user gets a simple **Use in…** workflow without hiding the
  platform's own final upload or permission step.
- MySkills can support new provider surfaces by adding capabilities and a
  projection profile instead of weakening one universal schema.
- Release identity, package digest, destination scope, and evidence remain
  auditable.
- Product copy and analytics can distinguish generated, handed off,
  user-confirmed, provider-observed, and runtime-verified outcomes.
- API project automation cannot accidentally claim or mutate a consumer
  workspace installation.

Costs and constraints:

- MySkills must maintain several package profiles and compatibility fixtures.
- Some provider workflows will remain manual when official management or
  readback interfaces are absent.
- Cross-platform content reuse is best effort. Target-specific overrides may be
  necessary and must remain reviewable.
- Provider documentation and UI changes require evidence expiry and periodic
  revalidation.
- A managed organization release does not automatically establish per-user
  installation or enablement.

## Alternatives rejected

- **One universal ZIP and install button.** Similar `SKILL.md` conventions do
  not establish identical package, security, runtime, or administration
  behavior.
- **Treat MCP as the cross-platform skill installer.** MCP exposes runtime
  tools or resources; it does not create a native skill-library entry.
- **Treat API skills as consumer workspace skills.** Official API resources use
  developer credentials and do not prove a web-app install.
- **Use browser automation for workspace management.** UI automation is brittle,
  difficult to scope safely, and cannot provide a stable product contract.
- **Call a download an installation.** This overstates state and produces
  misleading adoption and compliance records.
- **Allow provider-side edits to overwrite a release.** This would break
  immutability, review, provenance, and rollback. An authorized import should
  create a new draft candidate instead.

## Migration and rollback

The original provider-integration proposal changes no provider schema or
runtime behavior. A future export-only implementation should add versioned
projection contracts and receipts without changing immutable release bytes.
The current local Phase 2 branch separately contains tenancy, target
observation, and fixture-only sync/recovery foundations; those additions do
not provide a public live adapter, apply, or rollback path.

Each later adapter must have an independent feature flag and capability record.
Disabling an adapter stops new delivery while preserving releases, generated
artifact evidence, audit history, and the last observed external state. Provider
resources must not be deleted as an automatic schema or feature rollback.

## Current Phase 2 scope

This ADR remains a proposed boundary for provider delivery. The local Phase 2
branch expands the control-plane foundation around it:

- Team and organization tenancy foundations exist locally, including API
  contracts for organization policy and visibility. Architecture organization
  grants have manager-only GET/PUT replacement routes and web save/revoke
  controls with atomic policy-bound persistence. CLI skill-sharing can target
  organizations, but architecture organization-grant writes remain deferred
  in CLI/MCP.
- Pattern migration and diagramming are local control-plane features: the API
  exposes derive-shell preview/create with Postgres lineage and the web
  workbench exposes migration preview/create plus JSON/Mermaid/plain-outline
  diagram downloads. These outputs do not promote a provider target.
- The organization and connected-target web workbenches expose membership,
  policy, exact binding, consent, health, safe observation, and revoke
  controls. They manage MySkills metadata only.
- `myskills architectures observe` and `myskills architectures health` provide
  explicit-root, read-only Codex metadata and health reports. They do not
  discover a home, upload observations, or mutate a provider or target.
- Sync and recovery are persisted, fixture-only local planning/test
  capabilities with synthetic recovery and rollback evidence. No public live
  sync-run/apply/rollback route or provider adapter is available.

These capabilities are not provider evidence and do not change the promotion
gates in this ADR. The documented Phase 1 Railway baseline is separate and
requires live read-back; Phase 2 remains a local branch and is not deployed.

## Verification

Acceptance requires:

- deterministic fixture output and logical digest tests for each projection;
- negative tests for invalid structure, unsupported files, size, secrets, and
  unauthorized private releases;
- browser tests showing a provider/account-aware **Use in…** flow without
  overstated install language;
- a controlled live upload and runtime behavior check before promotion from
  `researched` to `pilot`;
- repeatable positive and negative live fixtures plus an evidence-expiry policy
  before promotion to `supported`;
- independent authorization, preview, apply, readback, retry, conflict, audit,
  and rollback tests before any managed publisher or API write adapter ships.

The current branch's source/test presence does not satisfy these live-provider
promotion gates. A future Phase 2 release also requires a clean supported-
runtime repository gate, disposable-Postgres/browser evidence where affected,
and a separately recorded hosted read-back.
