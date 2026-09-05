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

Beta.5 is the previously published source, CLI, and hosted operational release.
Beta.6 is a CLI-focused candidate. It adds the work/team bootstrap planner and
no API, web, migration, or hosted runtime behavior. A beta.6 source version or
passing unit test does not establish that Railway runs beta.6, and this release
does not require a Railway promotion.

Public npm publication, a GitHub prerelease, and a release tag remain separate
release actions. Building and testing a tarball does not publish it.

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

## Candidate Acceptance

- Run the complete canonical release gate on the immutable beta.6 candidate.
- Install the packed CLI in a fresh temporary root and verify its exact version.
- Run one disposable work-owned canary through `bootstrap codex --dry-run`.
  Verify no network access, no source or target mutation, a new private report,
  redacted terminal output, stable plan identities, and explicit target state.
- Verify that unapproved trust compartments, implicit selectors, sensitive
  configuration paths, stale contracts, and changing source or target identities
  fail closed.
- Read back the tag workflow, immutable npm package, npm `beta` selector, and
  GitHub prerelease. Keep `latest` and `alpha` unchanged.

## Beta Boundaries

- Hosted registration stays owner-controlled.
- Self-hosting and the supported local runtime path are the product focus.
- SSO, hosted billing, more provider runtimes, and durable model evaluations are
  outside this operational candidate.
- Adoption and support evidence are still required before a stable release.
- Unverified platform or runtime behavior must be listed as a limitation.

## Stop Rule

Do not publish with failed gates, a mismatched tag or version, incomplete planner
canary evidence, an unexpected npm selector change, or unverified immutable
package bytes. Fix the candidate and rerun the affected checks. Do not mutate
Railway for this CLI-only release. See [Release Process](RELEASE.md) for the
release and rollback procedures.
