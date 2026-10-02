# Beta.19 release delivery

Prepared: 2 October 2026. Target release: `v0.1.0-beta.19`.
Status: verification and publication preparation. No beta.19 tag, published
artifact or deployment is claimed by this record.

## Scope

Beta.19 combines the merged, unreleased beta.18 work with the architecture
explorer and roadmap candidate. The owner authorized completion of verification,
record reconciliation, packaging and publication. Production deployment is
outside this delivery action.

- API-backed CLI/MCP workflows, opt-in OAuth connections, dependency repairs,
  retained connector evidence and the standalone Railway MCP image from the
  [beta.18 candidate](BETA18_RELEASE_DELIVERY.md).
- Personal and team Library Collections and overlapping Groups, merged in
  [PR #124](https://github.com/jremick/myskills/pull/124), with inherited
  permissions, member pins and source tracking.
- Saved architecture structure/map exploration, node inspection and Workbench
  draft-change review from [PR #126](https://github.com/jremick/myskills/pull/126).
- [PR #133](https://github.com/jremick/myskills/pull/133)'s private multi-file
  author drafts and imports, exact published-release and reviewer comparisons,
  durable scan attempts and static evaluation evidence, browser/device CLI
  login, saved architecture reviews and separately approved composed Codex
  workspace delivery.
- Authorized task discovery using bounded word overlap, a separate product/docs
  site, and self-host Compose/operator tooling for setup, forward upgrades,
  coordinated backups and isolated recovery.

The API remains the state and permission authority. Review approval never
executes changes. Composed local apply and rollback require their distinct
approvals and current authority. Static evaluations are advisory; unconfigured
provider behavior stays skipped. See the [current source contracts and evidence
limits](ROADMAP_CANDIDATE_DELIVERY.md), [capability ledger](CAPABILITY_PARITY_IMPLEMENTATION.md)
and [self-host operator contract](SELF_HOST_OPERATOR.md).

## Explicit deferrals

The owner deferred live ChatGPT/Claude OAuth consent, actual provider tool use,
revocation and native skill recognition, physical authenticator scans, and
signed-in account/target pilots for this delivery. These outcomes remain
unverified; fixture, local, protocol or staging evidence does not complete them.
Retain the provider limitations and [physical MFA issue #49](https://github.com/jremick/myskills/issues/49).

These deferrals do not relax the full deterministic/runtime gate, HOST
install/upgrade/backup/restore proof, independent review, required security and
branch checks, immutable tag verification, or artifact identity. Broader provider
adapters, model-effectiveness claims, arm64 runtime, publisher signing, durable
visual-layout persistence and optional telemetry retain their separate decisions
or evidence limits. Public prebuilt image distribution and publisher signing
are pending a registry destination and signing-identity decision. Local OCI
archives and bundle-generation tooling do not establish a
published install bundle.

## Candidate and gate record

PR #133 was open and draft at head
`8e30f2f522299de5d146de9633f4cc24a837aad5` when this reconciliation began.
The latest prior run tested merge
`91de7f9f538f193f336810699dcf303dde53a235`: its three required runtime contexts
failed on 1 October 2026 at 14:29 UTC. PostgreSQL and browser component checks
passed, but the cancellation fixture and HOST port-binding gate failed.
CodeQL succeeded on that prior source. These results do not verify a corrected
final candidate.

The correction isolates observer tests from an independently armed observer and
separates native loopback publication from container-network backup access.
Owned runtime controls verified both routes and cleanup. Focused Node 22/24
checks passed; the complete final-source gate remains required.

The final record must use exact immutable source identities and retained
receipts. Update each row only from its matching evidence.

| Gate | Current state / evidence to record |
| --- | --- |
| Frozen candidate | Pending: full commit SHA and tree after source, release-record, parity and criterion-anchor reconciliation. |
| Full controller runtime verification | Pending on the final candidate: complete SHA-pinned Node 22/24 repository, PostgreSQL, browser/site and image matrix; actual HOST install/upgrade/backup/restore; export checksum and independent cleanup readback. |
| Independent review and required security checks | Pending on the final candidate: reviewed identity, matching CodeQL result and current alert-state readback. Earlier scan success is prior-source evidence. |
| Protected merge and repository controls | Pending: PR merge identity, required-context results and live branch/tag-protection readback. |
| Canonical candidate and tagged verification | Pending: clean `release:verify`, new immutable beta.19 tag and passing `scripts/local-ci.sh release-check` on that tag. Partial commands do not replace these gates. |
| Exact release artifacts | Pending: source and CLI archive identities, metadata, checksum set, unsigned provenance limits and independent byte verification. Local self-host image/bundle tooling is separate from public distribution. |
| Publication | Authorized, pending: GitHub source/CLI archives, metadata and checksums, plus npm `@jarel/myskills` on the `beta` selector. Record remote asset bytes and exact package/selector readback; public prebuilt images and publisher signing remain pending a registry destination and signing-identity decision. |
| Deployment | Outside this delivery action. No beta.19 staging or production deployment claim. |
| Live provider consent/recognition and physical MFA/pilots | Explicitly deferred by the owner; unverified. |

The [beta.18 record](BETA18_RELEASE_DELIVERY.md) preserves its Collections matrix,
CodeQL and phase-1 Railway staging identities. Those receipts remain historical
candidate evidence. They do not substitute for the later beta.19 gate. The
[release process](RELEASE.md) remains the canonical gate and publication runbook.

## Migrations and upgrade limits

Use the maintained migration runner in lexicographic filename order through
`0042_package_evaluations.sql`. Shared numeric prefixes are intentional; preserve
complete filename identities and migration history. Upgrades from beta.16 also
need the beta.17 GitHub/source/team-Library migrations.

Since beta.17, apply `0034_oauth_connections`, `0035_oauth_assurance`,
`0036_library_selections`, `0037_author_drafts`, `0038_device_login`,
`0039_package_scan_jobs`, `0040_architecture_plan_history`,
`0041_composed_architecture_artifact` and `0042_package_evaluations`.
Back up the database, artifacts and protected configuration before an upgrade.
Keep API/web on the same revision and use matching MCP source when enabled.

`0042_package_evaluations` was amended during unreleased candidate preparation.
An instance with an earlier working 0042 needs a fresh disposable candidate
schema or a separately reviewed forward migration. Do not reset a persisted
database or assume a recorded old migration shape was updated automatically.

Apply OAuth migrations before enabling connections; old grants gain no new
scope or MFA assurance by backfill. Retain additive tables and history when
disabling features or rolling application services back. The self-host helper's
migration barrier prevents automatic downgrade after forward migrations begin;
use the exact required runtime or isolated recovery. These compatibility notes
do not establish a successful runtime upgrade or restored application.

## Publication closeout

This file preserves the preparation snapshot. The final matrix, tag, artifact
checksums and publication readbacks belong in the
[beta.19 release record](https://github.com/jremick/myskills/releases/tag/v0.1.0-beta.19)
and [PR #133](https://github.com/jremick/myskills/pull/133), so the immutable source
archive does not need to change to record its own publication. Until those
readbacks exist, the pending rows above remain unverified. Preserve the 426
original criterion contracts and their source identities; current anchors and
status bindings remain separate records.
