# Operational Beta Delivery Brief

Version: 0.1.0-beta.6
Last updated: 2026-09-05

Target release: `v0.1.0-beta.6`.

## Goal

Extend the verified beta.5 operational baseline with one safe, local planning
path for explicitly approved work/team Codex skill bootstrap. The command must
remain dry-run only, must not discover candidates implicitly, and must not gain
network, registry, adoption, apply, or target-write behavior.

The complete work sequence, failure boundaries, and criterion-by-criterion
verification ledger are in [Operational Beta Delivery](OPERATIONAL_BETA_DELIVERY.md).
The beta.5 operational evidence remains the hosted baseline. Beta.6 adds a
separate CLI/package proof for the new planner.

## Release Outcome

Beta.6 was published as a CLI-focused npm package and GitHub prerelease on
5 September 2026. It adds the work/team bootstrap planner and no API, web,
migration, or hosted runtime behavior. The release did not promote Railway;
beta.5 remains the separately verified hosted operational baseline.

[PR #62](https://github.com/jremick/myskills/pull/62) merged as
`c940e4523397966975bf182b3f8239a3e9ee7376`. The immutable
`v0.1.0-beta.6` tag targets that exact commit. Its
[release workflow](https://github.com/jremick/myskills/actions/runs/33964168764)
passed before the [GitHub prerelease](https://github.com/jremick/myskills/releases/tag/v0.1.0-beta.6)
was published.

## Canonical Executable Gate

From a clean candidate checkout with the declared Node/npm versions, Chromium for
Playwright, and a disposable database whose name includes `test` or `ci`:

```bash
TEST_DATABASE_URL=postgres://myskills_test:myskills_test@localhost:5432/myskills_test npm run release:verify
```

This gate runs repository checks, production dependency audit, builds, web
typecheck, unit tests, prerelease checks, a fresh installed CLI tarball smoke,
route-mocked browser tests, production-like full-stack tests, Postgres integration,
and release artifact generation. Final artifact generation rejects a dirty tree.
The exact Railway Dockerfiles and the production Compose targets are release
verification surfaces, not substitute deployment evidence.

The CLI package includes `LICENSE`, `README.md`, `dist/index.js`, and the npm
package manifest. The installed license must match the root project license.

## Release Verification

- The complete canonical release gate passed on the clean beta.6 candidate.
- The CLI tarball contains only `LICENSE`, `README.md`, `dist/index.js`, and
  `package.json`. Its SHA-256 is
  `d20b0ffe61d5783f47bab43d22accb480fc1d799de8ce5937010be7364571098`.
- Fresh-cache installs of both the exact npm version and the `beta` selector
  returned `0.1.0-beta.6`, matched the verified package integrity, and passed
  public example validation and scanning.
- The disposable work-owned planner canary verified no network access, no
  source or target mutation, a new private report, redacted terminal output,
  stable plan identities, and explicit target state.
- Negative tests verified that unapproved trust compartments, implicit
  selectors, sensitive paths, stale contracts, changing identities, symlinks,
  and out-of-bound plans fail closed.
- npm `beta` resolves to `0.1.0-beta.6`. The `latest` and `alpha` selectors
  remain on `0.1.0-alpha.3`.

## Beta Boundaries

- Hosted registration stays owner-controlled.
- Self-hosting and the supported local runtime path are the product focus.
- SSO, hosted billing, more provider runtimes, and durable model evaluations are
  outside this CLI release.
- Adoption and support evidence are still required before a stable release.
- Unverified platform or runtime behavior must be listed as a limitation.

## Stop Rule

Do not publish with failed gates, a mismatched tag or version, incomplete planner
canary evidence, an unexpected npm selector change, or unverified immutable
package bytes. Fix the candidate and rerun the affected checks. Do not mutate
Railway for this CLI-only release. See [Release Process](RELEASE.md) for the
release and rollback procedures.
