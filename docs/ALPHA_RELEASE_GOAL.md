# Responsible Public Alpha Goal

Version: 0.1.0-alpha.0
Last updated: 2026-06-04

## Goal

Ship AI Skills Share as a responsible public alpha that people can inspect, run locally, evaluate, and self-host experimentally without mistaking it for the final business-safe production release.

## Release Boundary

The alpha includes:

- database-backed API and artifact storage boundary
- first-party email/password auth with MFA, scoped API tokens, roles, and admin registration controls
- public registry browsing, package submission, maintainer review, and publish flows
- CLI validation, scanning, login/logout, search/info, submit, review, export, install/update/rollback, and token management
- read-only stdio and HTTP MCP discovery/install-guidance tools
- Docker production image targets, Compose examples, production env preflight, and release artifacts
- one public-safe example skill package

The alpha explicitly excludes business-critical production guarantees. API contracts, package format, deployment defaults, and operational runbooks may change before `v1.0`.

## Release Gates

- `npm run check` passes from this repo.
- `npm run check:alpha-release` passes.
- Fresh clone can install dependencies, run checks, validate and scan the example package, and create release artifacts.
- `SECURITY.md`, `CONTRIBUTING.md`, `LICENSE`, README, release docs, threat model, and roadmap are public-safe.
- GitHub private vulnerability reporting is enabled before the public alpha is announced or tagged.
- Release artifact metadata shows `dirty: false`.
- The first public tag is `v0.1.0-alpha.0` unless `package.json` changes before release.

## Public Switch Checklist

1. Confirm the local worktree is clean and synced to `origin/main`.
2. Confirm latest GitHub CI on `main` is green.
3. Make the repository public.
4. Enable GitHub private vulnerability reporting.
5. Create and push the tag:

   ```bash
   git tag v0.1.0-alpha.0
   git push origin v0.1.0-alpha.0
   ```

6. Confirm the tag-triggered release workflow succeeds and uploads artifacts.

## Stop Conditions

- Any privacy or secret scan finding.
- Any access-control, artifact-integrity, or package-parser issue without a documented alpha mitigation.
- Fresh-clone rehearsal failure that blocks setup, checks, example validation, or release artifact creation.
- Missing private vulnerability reporting path before the public alpha is announced or tagged.
