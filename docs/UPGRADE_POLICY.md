# Upgrade And Migration Policy

Version: 0.1.0-beta.4
Last updated: 2026-09-02

MySkills is prerelease software. This policy sets expectations for alpha and beta users without implying stable `v1.0` compatibility.

## Prerelease Policy

- `0.1.0-alpha.*`: evaluation, local demos, and early self-hosting feedback.
- `0.1.0-beta.*`: external trial use with clearer install, support, and compatibility expectations.
- `1.0.0`: stable compatibility policy to be defined after beta feedback and production hardening.

Breaking changes may happen during alpha and beta. The project should document them in release notes and [CHANGELOG.md](../CHANGELOG.md).

## Database Migrations

- Migrations are intended to be applied in order.
- Test and CI databases may be reset.
- Production-like databases should be backed up before migrations.
- Downgrade migrations are not guaranteed during prerelease.
- If an alpha database shape cannot be upgraded safely, the release notes must say so.

## API And CLI Changes

- API route shapes, error details, and auth/session behavior may change before `v1.0`.
- CLI commands should avoid unnecessary churn, but flags and output may change during prerelease.
- Breaking CLI changes should include examples for the new command or flag shape.

## Package Format Changes

- Skill package manifest changes should be validated by `myskills validate`.
- Breaking package-format changes should include migration guidance or an explicit incompatibility note.
- Approved release artifacts should keep checksum metadata so clients can verify downloaded/exported bundles.

## Deprecation Expectations

During alpha and beta, deprecations may be shorter than stable releases. When practical:

- Announce the deprecated API, CLI command, manifest field, or config value in release notes.
- Keep the older path working for at least one prerelease when it is low risk.
- Prefer explicit errors over silent behavior changes.

## Operator Guidance

Before upgrading a self-hosted instance:

1. Read [CHANGELOG.md](../CHANGELOG.md) and release notes.
2. Back up Postgres and object storage.
3. Run migrations in a staging or disposable environment when possible.
4. Run `npm run check` and the relevant smoke tests for API, web, CLI, and MCP.
5. Keep rollback notes for the previous deployed commit and container images.

## Skill Release Contract

Every published skill release has one immutable artifact and SHA-256 digest. It also has release notes, a change kind, a user-action flag, and optional minimum MySkills, adapter-contract, and source-version requirements. Clients must use SemVer precedence and must not treat a newer but incompatible release as installable.

The registry remains the source of release metadata. A connected target observation remains the source of installed state. A successful operation receipt can temporarily supersede an older observation until the companion submits a fresh readback.

## User Update Flow

1. Open **Updates** to see installed versions, compatible candidates, policy blocks, drift, and active operations across visible targets.
2. Open one candidate to review all release notes between the installed and proposed versions. The review binds the exact target, version, platform, byte size, and artifact digest.
3. Queue one update or review a bounded batch. Queueing does not grant execution authority.
4. A contract-v2 companion with a `targets:execute` API token claims the operation. Consent, current target generation, capabilities, release visibility, policy, and maintenance window are checked again.
5. The companion verifies the artifact, stages the package on the same filesystem, atomically swaps the installation, writes the registry journal, and performs local readback.
6. The UI polls the bounded operation state and displays the sanitized receipt. A successful operation exposes rollback when a verified previous snapshot exists.

Queued operations can be cancelled before claim. Claimed work uses a short lease and a fencing token. After an expired lease, another companion can recover the operation with a higher fence; the stale worker can no longer advance or complete it.

## Local CLI Flow

- `myskills updates` calculates compatible candidates without changing disk state.
- `myskills update <slug> --dry-run` shows the candidate, skipped release notes, compatibility requirements, and required user actions.
- `myskills update <slug>` downloads and verifies the exact manifest and artifact before a transactional install.
- `myskills rollback <slug>` restores a verified local snapshot through the same transaction journal.
- On the next registry read, an incomplete transaction is recovered deterministically. Local content drift is reported and never overwritten silently.

## Upgrade Policy

Upgrade policies are immutable revisions with optimistic concurrency. A target policy overrides an organization policy; otherwise the fail-safe default is stable-channel, manual updates. A policy can:

- include or exclude prereleases;
- permit selected change kinds;
- pin exact skill versions;
- keep execution manual or restrict companion claims to a declared timezone-aware maintenance window.

Organization policy changes require an MFA-verified organization owner. Target policy changes require an MFA-verified target manager and a write-capable, consented target.

Architectures keep exact skill version and digest references. The update centre can create a new immutable architecture revision from reviewed compatible candidates. Creating that desired-state revision does not update a physical target; target operations remain separately reviewed and queued.

## Recovery Boundaries

Skill rollback restores package files and the local install registry. It does not roll back MySkills server code, database migrations, or object storage. Operators must continue to use the deployment backup and restore procedure for system releases.

The UI never receives companion claim tokens, stored credential references, package contents, filesystem paths, or raw executor errors. Receipts contain bounded status codes, versions, and digests only.
