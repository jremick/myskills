# Release Process

Version: 0.1.0-beta.5
Last updated: 2026-09-05

MySkills beta releases are verification-first and approval-gated. A passing command is evidence about one commit; it is not permission to create a tag, publish a package, create a GitHub Release, push an image, or deploy production.

The archived alpha criteria remain in [Alpha Release Goal](ALPHA_RELEASE_GOAL.md). The current acceptance ledger is [Public Beta Delivery Brief](BETA_RELEASE_GOAL.md).

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

The source version `0.1.0-beta.5` and `publishConfig.tag=beta` are coherent. `@myskills-app/skill-package` remains a private build-time dependency only; esbuild embeds it in the public CLI bundle.

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

- **Source tag/release**: do not delete, reuse, or move a released tag. Fix forward with a new prerelease version. If public notes were wrong, correct the release text without changing artifact identity.
- **npm**: move the `beta` dist-tag back to the last known-good published version after owner approval. Prefer deprecation guidance over unpublishing; do not move `latest` as part of beta rollback.
- **Railway app services**: redeploy the last known-good API commit first, wait for API readiness, and then redeploy web from that same commit. Repeat same-origin health/browser/CLI/MCP readbacks and record any temporary mixed-version interval as an incident.
- **Database**: migrations are forward-only by default. Do not run ad hoc down migrations. If a schema/data change is incompatible, stop promotion and choose a tested forward repair or an explicitly approved backup restore with accepted data-loss bounds.
- **Artifacts**: immutable package bytes are never overwritten. Revoke/unpublish the affected release through the API and issue a replacement version.

Rollback is complete only when the selected previous version is read back from the relevant live surface and the incident/acceptance record names what remains open.
