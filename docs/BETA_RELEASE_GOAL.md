# Operational Beta Delivery Brief

Version: 0.1.0-beta.15
Last updated: 2026-09-28

Target release: `v0.1.0-beta.15`.

Status: beta.15 browser-branding candidate; beta.14 remains the verified hosted release.

## Beta.15 Candidate

Extend saved instance branding to the browser tab title and favicon. Verify
save, draft/failure isolation, reload, public pages, hidden text, all three image
formats, removal and reset. Preserve the beta.14 API and storage contracts.
See [Beta.15 release delivery](BETA15_RELEASE_DELIVERY.md).

## Beta.14 Release Record

Owner/admin branding controls are live at myskills.sh, with safe image upload,
editable text, preview, reset and audit history. The release includes beta.13
QR enrollment. Tag, staging and production use
`5647be19f15a8f9bb2c6b0ecfb067478b7528ed0`. Canonical and tagged verification,
protected CI, live acceptance and remote archive checksums passed. No schema
migration is required; npm remains beta.8. See
[Beta.14 release delivery](BETA14_RELEASE_DELIVERY.md).

## Beta.13 Release Record

Locally rendered authenticator enrollment QR codes with manual setup fallbacks
are live at myskills.sh. The immutable tag and production API/web pair use
`48273d5ff401ddcfd9046c448b1b38a58ee12337`. The clean canonical gate, protected CI
and staging/production acceptance passed. Tagged verification and remote release
asset checksums passed. npm remains beta.8. No database
migration or API contract change is included. Physical authenticator-app scans
remain outstanding. See [Beta.13 release delivery](BETA13_RELEASE_DELIVERY.md).

## Beta.12 Release Record

All four Opus-led application redesign waves are published on GitHub and live
at myskills.sh. The immutable tag and production API/web pair use source
`c280795e6f0bd54533514ab6c58af7a584cbd3a4`. Visual acceptance, protected-branch
CI, clean canonical verification, tagged verification, staging and production
checks passed. Existing exact-version, authorization and mutation contracts
remain. See [Beta.12 release delivery](BETA12_RELEASE_DELIVERY.md).

Beta.12 supersedes the unpublished beta.11 candidate after correcting browser
test synchronization. No application source changed after Opus acceptance.
GitHub and hosted delivery are complete; npm remains beta.8.

## Beta.10 Release Record

Skill bundles are published on GitHub and live at myskills.sh. The immutable tag
and production API/web pair use `084b48e4bce0e8693357f7a4f89d7aabf8ff89f4`.
Required CI, clean canonical verification, the tagged workflow, staging
acceptance and production checks passed. Grouped, List and Outline views,
curated/source relationships and reference-only Library saving are included.
See [Beta.10 release delivery](BETA10_RELEASE_DELIVERY.md) for evidence, migration
and rollback limits. npm remains beta.8.

## Beta.9 Release Record

The optional marketing homepage is published on GitHub and live at myskills.sh.
The immutable tag and both production services use source
`4e728b16cc04f11faa7e23ad0657913b67f50577`. Canonical release verification,
required CI, staging acceptance and production browser checks passed. See
[Beta.9 Release Delivery](BETA9_RELEASE_DELIVERY.md) for exact evidence.
The outbox/email-settings workstream is separate. npm remains beta.8.

## Beta.8 Release Record

Beta.8 adds Libraries: saved public GitHub sources, immutable import
previews and provenance, administrator-controlled private self-review, scheduled
source checks, an opt-in change inbox, team curation, and explicit adoption that
constrains local and connected-target updates.

It also adds governed skill improvement: model/app/environment declarations,
reviewer policies, local Claude Code runs, paired evaluation and reviewed evidence.
GitHub publication, production promotion and npm publication are complete.
Install with `npm install -g @jarel/myskills@beta`, or pin
`@jarel/myskills@0.1.0-beta.8`. Exact registry bytes and fresh installs through both
selectors passed; `latest` and `alpha` remain `0.1.0-alpha.3`.

The combined acceptance record is [Beta.8 Release Delivery](BETA8_RELEASE_DELIVERY.md).
The Libraries implementation record is
[Libraries build evidence](plans/2026-09-26-library-build-evidence.md); the full
feature and later phases are in the [Libraries specification](plans/2026-09-26-library-feature-spec.md).
The canonical gate, persistent multi-actor journeys, populated-data migration
rehearsal and blocking review resolutions passed before promotion.
The beta.7 record below remains historical release evidence.

## Beta.7 Release Record

Beta.7 extends the published beta.6 baseline with deterministic local package
authoring, authorized native MCP Skills delivery, public release-history
navigation, and reviewed auth, package-integrity, governance, dependency, and
self-hosting repairs. [PR #84](https://github.com/jremick/myskills/pull/84) is
merged, and the immutable `v0.1.0-beta.7` tag resolves to
`6912d3f9490c6f002431f3064e8a9db417df3d7f`.

The candidate has 12 successful GitHub checks, a passing Windows-hosted Linux
canonical gate, successful same-revision beta.7 staging API and web deployments,
public rendered catalogue/version-selector/package
checks, and passing Windows CLI `doctor`, `export`, `validate`, and `scan` checks.
The visible staging selector contained one version; historical-version selection
was not tested. Fresh coordinated
capture/restore, candidate migration/runtime readiness, and legacy runtime
compatibility reports also passed. The detailed evidence and limits are in
[Beta.7 Release Delivery](BETA7_RELEASE_DELIVERY.md).

Tagged release workflow `36100097156` completed successfully. The GitHub
prerelease was briefly published before authenticated staging acceptance, then
returned to draft. This is a recorded sequencing deviation, not an acceptance
waiver. Owner recovery and login/MFA preparation passed. The Windows API/CLI
acceptance was then accepted at `2026-09-25T07:26:28.111262Z` with 20 real
checks and zero supplied-session cleanup failures. Separate native Comet proof
passed owner login, temporary-MFA session invalidation, exact release
notes/version, literal `SKILL.md`, and revoked-version denial. The stale
continuation marker means no continuous role-browser suite is claimed. GitHub
publication and production promotion completed. At that historical checkpoint,
npm publication remained pending passkey; the current beta.8 npm release is
recorded above. Fix-forward is preferred; legacy readiness does not prove a
full rollback, and no live rollback was executed.

Native model-selected host activation remains open. Folder/ZIP imports, browser
drafts, and guided self-hosting setup remain subsequent roadmap slices.

## Beta.6 Historical Goal

Extend the verified beta.5 operational baseline with one safe, local planning
path for explicitly approved work/team Codex skill bootstrap. The command must
remain dry-run only, must not discover candidates implicitly, and must not gain
network, registry, adoption, apply, or target-write behavior.

The complete work sequence, failure boundaries, and criterion-by-criterion
verification ledger are in [Operational Beta Delivery](OPERATIONAL_BETA_DELIVERY.md).
The beta.5 operational evidence remains the hosted baseline. Beta.6 adds a
separate CLI/package proof for the new planner.

## Beta.6 Historical Outcome

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

## Beta.6 Historical Verification

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

## Beta.6 Historical Boundaries

- Hosted registration stays owner-controlled.
- Self-hosting and the supported local runtime path are the product focus.
- SSO, hosted billing, more provider runtimes, and durable model evaluations are
  outside this CLI release.
- Adoption and support evidence are still required before a stable release.
- Unverified platform or runtime behavior must be listed as a limitation.

## Beta.7 Stop Rule

Do not publish with failed gates, a mismatched tag or version, incomplete
authoring or native-MCP evidence, an unexpected npm selector change, or
unverified immutable package bytes. Do not promote API or web until the
candidate has passed staging, migration, backup, readiness, and same-commit
browser/API readbacks. Fix the candidate and rerun the affected checks. See
[Release Process](RELEASE.md) for the release and rollback procedures.
