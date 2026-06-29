# Upgrade And Migration Policy

Version: 0.1.0-alpha.0
Last updated: 2026-06-30

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
