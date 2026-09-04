# Operational Beta Delivery Brief

Version: 0.1.0-beta.5
Last updated: 2026-09-05

Target release: `v0.1.0-beta.5`.

## Goal

Complete the reviewed-package-to-working-skill journey for individuals and small
teams, with safe updates, useful review feedback, reliable discovery, and tested
operator recovery. Preserve the API/Postgres source of truth and prove one
workspace-scoped Codex runtime path.

The complete work sequence, failure boundaries, and criterion-by-criterion
verification ledger are in [Operational Beta Delivery](OPERATIONAL_BETA_DELIVERY.md).
The candidate remains in progress until that ledger contains actual evidence.

## Release Outcome

Beta.4 is the previously published source and CLI release. Beta.5 is the current
operational candidate. A source version or passing unit test does not establish
that Railway runs it. Verify the immutable revision returned by API and web
`/version.json`, plus rendered and runtime behavior, before making a live claim.

Public npm publication, a GitHub prerelease, and a release tag remain separate
release actions. Building and testing a tarball does not publish it. The current
work includes existing Railway staging and production promotion after the gates.

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

## Live Acceptance

Use the existing isolated Railway staging environment. Exercise distinct author,
reviewer, and consumer accounts through correction, approval, publication,
discovery, installation, update, rollback, and revocation. Use a disposable Codex
workspace and preserve the user's existing skills and credentials. A successful
filesystem operation is not evidence that Codex loaded the skill.

Rehearse database plus artifact recovery into an isolated destination. Capture a
current production recovery point, then deploy API before web from the same
verified source. Require direct and same-origin readiness, source identity,
authentication, registry, and artifact-delivery checks plus rendered evidence.

## Beta Boundaries

- Hosted registration stays owner-controlled.
- Self-hosting and the supported local runtime path are the product focus.
- SSO, hosted billing, more provider runtimes, and durable model evaluations are
  outside this operational candidate.
- Adoption and support evidence are still required before a stable release.
- Unverified platform or runtime behavior must be listed as a limitation.

## Stop Rule

Do not promote or publish with failed gates, mismatched API/web revisions, unsafe
migration compatibility, missing recovery evidence, or unverified authentication.
Fix the candidate and rerun the affected checks. Never overwrite production to
prove restore behavior. See [Release Process](RELEASE.md) and
[Railway Deployment](RAILWAY_DEPLOYMENT.md) for operator procedures.
