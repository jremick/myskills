# Release Process

Version: 0.1.0-beta.8
Last updated: 2026-09-26

MySkills beta releases are verification-first and approval-gated. A passing command is evidence about one commit; it is not permission to create a tag, publish a package, create a GitHub Release, push an image, or deploy production.

The archived alpha criteria remain in [Alpha Release Goal](ALPHA_RELEASE_GOAL.md). The current acceptance ledger is [Public Beta Delivery Brief](BETA_RELEASE_GOAL.md).

## Beta.8 Release Record

Released tag: `v0.1.0-beta.8`, source `55849876639fbb55167496051bd8d573b5a6a6af`.

The GitHub prerelease and production API/web promotion are verified. npm
publication remains pending maintainer passkey authentication; use the verified
CLI archive attached to the GitHub release until the `beta` selector is updated.
Do not infer npm publication from the source version or hosted deployment.

The release contains source-tracked Libraries and governed skill improvement. The approved scope, failure cases and evidence are recorded in the [beta.8 delivery ledger](BETA8_RELEASE_DELIVERY.md), [Libraries build ledger](plans/2026-09-26-library-build-evidence.md) and [skill improvement ledger](SKILL_IMPROVEMENT_DELIVERY.md).
Run container tests on the Windows PC when available; remote execution must
still produce the canonical gate and exact candidate evidence. A local source
change is not release, npm or production evidence.

## Beta.7 Historical Candidate Acceptance Record

Target release: `v0.1.0-beta.7`.

The candidate extends beta.6 with deterministic local package authoring,
authorized native MCP Skills delivery, public release-history navigation, and
the reviewed auth, package-integrity, governance, dependency, and self-hosting
repairs merged through `origin/main` at `7f21e4bf1e60a105ada93445f4ee1e2955c69b8e`.
It does not claim model-selected native host activation, folder/ZIP imports,
browser drafts, or guided self-hosting setup; those remain roadmap work.

Acceptance is recorded against the final immutable candidate commit. Before
tagging, verify the clean canonical gate, required GitHub checks, staging
acceptance, migration safety, and recovery readiness. After package publication,
verify the exact npm bytes and `beta` selector, with `latest` and `alpha`
unchanged. After production promotion, verify API/web identity, readiness, and
rendered acceptance. The final record must name the candidate SHA, evidence
links, deployment IDs, and remaining beta limitations. This preparation record
does not claim that those gates passed.

## Canonical Candidate Gate

Install Chromium once for the local Playwright runner:

```bash
npx playwright install chromium
```

From a clean candidate checkout, with a disposable database whose name includes `test` or `ci`, run:

```bash
TEST_DATABASE_URL=postgres://myskills_test:myskills_test@localhost:5432/myskills_test npm run release:verify
```

This single command runs repo quality/security checks, the exact public CLI pack/install smoke, route-mocked browser E2E, a production-like Docker Compose API/web/MinIO/Postgres browser journey, Postgres integration, and release artifact creation. Use `npm run check:prerelease`, `npm run smoke:cli-package`, or individual test commands only to diagnose a failure; do not substitute a collection of partial runs for the canonical gate.

When using the Windows PC for container testing, run the verifier and PostgreSQL on that host so lease checks use the same clock. The verifier needs a clean Git checkout of the candidate, including `.git` and `.github`; the production Docker build context excludes those paths and is not a complete release-verification checkout. Match the Playwright container version to the repository's installed Playwright version and retain the reports and artifacts before removing the disposable runner.

Each canonical run creates a unique `dist/release-verify-*/artifacts/` bundle so repeated verification never deletes or reuses an earlier output. The bundle contains:

- `myskills-app-<version>-source.tar`: tracked source from `HEAD` under a versioned prefix.
- `release-metadata.json`: name, version, expected tag, commit identity/time, Node/npm metadata, and artifact checksums/sizes.
- `SHA256SUMS`: checksums for the source archive and metadata.

Final artifact generation refuses a dirty worktree. `--allow-dirty` exists only for script development because uncommitted files are not included in the source archive. Direct `release:artifacts` calls also refuse to overwrite an existing output directory.

## Staging And User Test

1. Select one immutable candidate commit on a branch. Record the full SHA and intended version.
2. Require the GitHub CI jobs for that commit to pass on Node 22 and 24 LTS, web E2E, and disposable Postgres.
3. Exercise the same commit through a dedicated staging environment. If no dedicated Railway staging environment is configured, the documented production Compose stack may serve as beta staging, but record that limitation; do not use Railway production as the first test environment.
4. Record user-test evidence for first-run setup, login/MFA, owner invitation and invitee registration through a captured or staging-only email, public browse/detail, author submission/withdrawal, maintainer artifact inspection and hash-attested review/publication, CLI validate/scan/search/export/install/rollback, and MCP read-only discovery.
5. Re-run the canonical gate after any candidate change. Evidence from an earlier SHA is stale.

Staging deployment is not release approval. User-test acceptance is a maintainer judgment recorded against the immutable SHA; it does not authorize external writes by itself.

## Approval Boundary

The owner approves each external action separately and in order:

1. **Tag approval**: authorize creation/push of `v<package-version>` only after the acceptance ledger, clean canonical gate, current GitHub controls, and staging/user-test evidence are reviewed.
2. **Package/release approval**: after the verification-only tag workflow passes, separately authorize any npm `beta` publish, GitHub Release creation, container registry push, or public announcement. The current workflow performs none of these actions.
3. **Production approval**: separately authorize Railway production migration/deploy. API and web must use the same commit; the migration plan, backup/restore readiness, smoke owner, and rollback target must be named.

A green workflow is evidence, not an approval signal. Never reuse or move an existing tag to repair a failed release.

## Tag And Workflow Protection

The release workflow triggers on `v*.*.*` tags and:

- checks out full history;
- requires the tag to equal `v<root package version>`;
- resolves the tag commit and requires it to be an ancestor of `origin/main`;
- runs the canonical release gate with tag enforcement;
- builds the root Dockerfile `api`, `web`, and `mcp-http` targets plus the exact `Dockerfile.api` and `Dockerfile.web` used by Railway;
- builds `Dockerfile.backup` and checks both command entrypoints without credentials or network access;
- uploads verification artifacts only.

Configure a GitHub ruleset for the release-tag pattern (for example `v*`) that restricts tag creation, update, and deletion to the release maintainer role. Protect `main` with the aggregate `check` context (which requires both Node matrix jobs), web E2E, and Postgres integration; require current branches and choose administrator bypass deliberately. Read the live ruleset/protection state immediately before release; workflow YAML cannot prove that repository settings are applied.

## Tagging

Only after explicit tag approval:

```bash
VERSION=$(node -p "require('./package.json').version")
git tag "v${VERSION}"
git push origin "v${VERSION}"
```

Draft public release text in a file and use `--notes-file` or the GitHub UI if a later approval authorizes a GitHub Release. Do not place shell snippets, env names, or backticks in an inline `gh release create --notes` argument.

## CLI Package Candidate

The candidate source version is `0.1.0-beta.8`, with `publishConfig.tag=beta`. `@myskills-app/skill-package` remains a private build-time dependency only; esbuild embeds it in the public CLI bundle. Candidate preparation does not change the published npm version.

The canonical gate proves:

- npm's tarball metadata exactly matches the allowlist (`LICENSE`, `README.md`, `dist/index.js`, `package.json`), and its license matches the repository license;
- the bundle has no private workspace runtime import;
- a clean temporary install succeeds from the packed tarball with only public npm dependencies;
- the installed `myskills` runs `--version`, validates the public example, and scans it.

No workflow publishes npm. If the owner separately approves a manual beta publish, first inspect current dist-tags and run a dry run:

```bash
npm view @jarel/myskills version dist-tags
npm publish -w @jarel/myskills --access public --tag beta --dry-run
```

Until trusted publishing is configured, the approved maintainer may use npm's browser/passkey flow from a TTY with `--provenance=false`. Verify the beta dist-tag and install in a clean directory after publication. Never move `latest` to a prerelease unintentionally.

Registry selectors and local npm metadata caches can lag immediately after a
publish. Verify immutable package bytes before the mutable channel selector:

```bash
VERSION=$(node -p "require('./apps/cli/package.json').version")
npm view "@jarel/myskills@${VERSION}" version dist.shasum dist.integrity

EXACT_ROOT=$(mktemp -d)
EXACT_CACHE=$(mktemp -d)
npm install --prefix "$EXACT_ROOT" --cache "$EXACT_CACHE" --prefer-online \
  "@jarel/myskills@${VERSION}"
"$EXACT_ROOT/node_modules/.bin/myskills" --version

npm view @jarel/myskills dist-tags
CHANNEL_ROOT=$(mktemp -d)
CHANNEL_CACHE=$(mktemp -d)
npm install --prefix "$CHANNEL_ROOT" --cache "$CHANNEL_CACHE" --prefer-online \
  @jarel/myskills@beta
"$CHANNEL_ROOT/node_modules/.bin/myskills" --version
```

Both installed versions must equal `VERSION`, `beta` must resolve to `VERSION`,
and `latest` must remain unchanged. Retry the read-back within a bounded window
when the exact version is correct but the channel is still stale; do not
misclassify a stale selector as incorrect package bytes.

## Production Promotion

Production deploy truth comes from [Railway Deployment](RAILWAY_DEPLOYMENT.md) and live Railway readback, not local Git state. Before approval, record the candidate commit, current production commit/deploy IDs, migration requirement, database backup/restore posture, API/web service targets, and rollback owner.

Promote API and web from the same commit, but do not replace them concurrently. Run migrations, deploy the API, wait for the platform deployment to report success, and verify the API `/ready` endpoint before deploying the web service. Deploying web only after API readiness ensures its upstream proxy starts against the healthy API deployment instead of retaining an address for a retiring instance. Do not rerun owner seed after bootstrap. After web promotion, verify same-origin `/api/ready`, public skill detail, browser login/MFA, authenticated export, CLI capability/version, and MCP authorization.

## Rollback

### Libraries beta.8 compatibility boundary

Beta.7 does not understand private self-review attestations or library target constraints. After beta.8 creates either, rolling the API back to beta.7 would remove those authorization checks. Disabling private self-review stops new attestations; it does not make existing data safe for an older API.

Before enabling Libraries writes, drain older API instances and workers. Preserve a database-and-artifact recovery point. For an incident after Libraries writes, fix forward or select an API/web pair that retains the beta.8 guards. Do not use the general previous-commit rollback below until the chosen code is compatible with the retained library records. A restore to an earlier recovery point needs separate approval for its data loss and artifact consistency plan; do not drop library tables as a rollback shortcut.

These read-only counts identify two downgrade blockers after migration 0032; zero counts alone do not replace compatibility review:

```sql
SELECT count(*) AS private_attestations
FROM skill_version_review_attestations WHERE kind = 'private-self-review';
SELECT count(*) AS library_target_bindings FROM library_target_bindings;
```

- **Source tag/release**: do not delete, reuse, or move a released tag. Fix forward with a new prerelease version. If public notes were wrong, correct the release text without changing artifact identity.
- **npm**: move the `beta` dist-tag back to the last known-good published version after owner approval. Prefer deprecation guidance over unpublishing; do not move `latest` as part of beta rollback.
- **Railway app services**: redeploy the last known-good API commit first, wait for API readiness, and then redeploy web from that same commit. Repeat same-origin health/browser/CLI/MCP readbacks and record any temporary mixed-version interval as an incident.
- **Database**: migrations are forward-only by default. Do not run ad hoc down migrations. If a schema/data change is incompatible, stop promotion and choose a tested forward repair or an explicitly approved backup restore with accepted data-loss bounds.
- **Artifacts**: immutable package bytes are never overwritten. Revoke/unpublish the affected release through the API and issue a replacement version.

Rollback is complete only when the selected previous version is read back from the relevant live surface and the incident/acceptance record names what remains open.
