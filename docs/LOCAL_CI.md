# Local CI And Release Checks

`scripts/local-ci.sh` runs the same gates as the GitHub Actions workflows on a Linux host with
Docker. Contributors can use it before opening a pull request. An external runner can call it
after checkout and read its evidence. The GitHub workflows remain in place until a replacement
has shown equivalent results; this entrypoint does not report statuses or publish anything.

## Requirements

- Linux on amd64. The E2E Compose file pins MinIO to `linux/amd64`, so other architectures need
  emulation and do not give equivalent evidence.
- Docker Engine with Compose v2 and BuildKit, reachable through the local socket.
- Git, Bash and network access to the npm registry, Docker Hub, GitHub release assets (MinIO
  binaries) and the Playwright browser download host.
- Node.js 22 (at least 22.13) and Node.js 24, each with the npm version in `package.json`
  `packageManager`. The script checks versions; it never installs npm globally.
- Chromium system libraries for Playwright. CI installs them with `--with-deps`; locally install
  them once with `sudo npx playwright install-deps chromium`.

## Usage

Commit first. The script tests the checked-out commit in fresh clones and refuses a dirty tree.

```bash
export LOCAL_CI_RUN_ID="pr-123-$(date +%s)"
export LOCAL_CI_EVIDENCE_DIR="$HOME/local-ci-evidence/$LOCAL_CI_RUN_ID"
export LOCAL_CI_NODE22_BIN=/path/to/node-22/bin
export LOCAL_CI_NODE24_BIN=/path/to/node-24/bin
export LOCAL_CI_SOURCE_SHA="$(git rev-parse HEAD)"
scripts/local-ci.sh verify
scripts/local-ci.sh verify --job check-node22   # one job; the result is marked non-gating
```

Release verification needs the release tag at `HEAD` and a main ref that contains it:

```bash
git fetch origin main --tags
LOCAL_CI_RELEASE_TAG="v$(node -p 'require("./package.json").version')" scripts/local-ci.sh release-check
```

CodeQL needs an official CodeQL CLI bundle:

```bash
LOCAL_CI_CODEQL_BIN=/path/to/codeql/codeql scripts/local-ci.sh codeql
```

| Mode | Jobs |
|---|---|
| `verify` | `check-node22`, `postgres-node22`, `web-e2e-node22`, `check-node24`, `postgres-node24`, `web-e2e-node24`, `railway-images` |
| `release-check` | `release` |
| `codeql` | `codeql-javascript-typescript` |

## Inputs

| Variable | Rule |
|---|---|
| `LOCAL_CI_RUN_ID` | Required. 1-48 lowercase letters, digits or hyphens. It names every container, Compose project, image tag and the workspace. |
| `LOCAL_CI_EVIDENCE_DIR` | Required. Absolute, outside the source tree, and without an earlier `result.json`. |
| `LOCAL_CI_SOURCE_SHA` | Optional. Must equal `HEAD`. Without it the result is not gating. |
| `LOCAL_CI_NODE22_BIN`, `LOCAL_CI_NODE24_BIN` | Directories containing `node`, `npm` and `npx`. When unset, `node` on `PATH` is used only for its own major version. |
| `LOCAL_CI_WORK_DIR` | Optional parent for the per-run workspace. Defaults to the OS temporary directory. |
| `LOCAL_CI_RELEASE_TAG`, `LOCAL_CI_MAIN_REF` | `release-check` only. The tag must be `v<package version>` and point at `HEAD`. `HEAD` must be an ancestor of the main ref (default `refs/remotes/origin/main`). The script does not fetch. |
| `LOCAL_CI_CODEQL_BIN`, `LOCAL_CI_CODEQL_CATEGORY` | `codeql` only. The category defaults to `/language:javascript-typescript`. |
| `MYSKILLS_E2E_PORT`, `MYSKILLS_E2E_WEB_PORT`, `MYSKILLS_E2E_MAILPIT_PORT` | Optional loopback ports. Free ports are chosen when unset. |

Jobs receive an allowlisted environment (paths, locale, Docker endpoint, proxy and CA settings,
browser and npm caches) with `CI=true`. Tokens such as `GITHUB_TOKEN` or `NPM_TOKEN` are not
passed to jobs. Do not keep publishing credentials in the account that runs jobs: dependency
scripts and tests run with that account's files and its Docker access.

## Results

Exit status 0 means passed, 1 failed, 2 rejected before any work, and 128 plus the signal number
means cancelled. Read `result.json` rather than relying on the exit status. It is written
atomically and contains:

- `status`: `passed`, `failed`, `rejected` or `cancelled`. `passed` also requires complete
  cleanup and clean evidence.
- `gating` and `gatingBlockers`: only a complete job set with a verified `LOCAL_CI_SOURCE_SHA` can
  gate a commit.
- `contexts`: for a complete `verify` run, the protected-branch contexts `check`, `web-e2e` and
  `postgres-integration`. Partial runs report `null`.
- `jobs`: status, reason, steps, exit codes, timings and a hashed log for each job.
- `cleanup` and `artifacts`: cleanup outcome and the SHA-256 of every evidence file.

Other evidence: `logs/<job>.log`, `resources.json`, `environment.json`,
`browser-evidence/<job>/` (the reviewed summaries and screenshots from
`scripts/collect-browser-evidence.mjs`), `release/` (verified artifacts and
`verification.json`) and `codeql/` (SARIF and a summary).

Credential-shaped output is replaced with `[redacted]` in logs and fails the run. The full-stack
runner also redacts its generated credentials. Raw Playwright reports, traces and videos stay in
the job clone and are deleted with it.

## Isolation And Cleanup

Each job runs in its own clone of the pinned commit inside
`<work dir>/myskills-local-ci-<run id>`. The workspace is created exclusively, so two runs cannot
share a run ID on one host. The script records each container, Compose project and image in
`resources.json` before or as it creates it, and removes only those exact names. Compose cleanup
matches the exact `com.docker.compose.project` label. A container whose creation failed, for
example because of a name conflict, is never removed. The script never prunes and never matches
name prefixes. Shared npm, Playwright and Docker build caches are kept.

Each step runs in its own process group. `SIGTERM` stops the current step, cleans up and writes a
cancelled result; allow about 60 seconds. After `SIGKILL`, use `resources.json` to remove the
listed resources.

## Mapping From GitHub Actions

| Workflow gate | Local equivalent | Difference |
|---|---|---|
| CI `Check / Node 22.x`, `Check / Node 24.x`: `npm ci`, `npm run check` | `check-node22`, `check-node24` | Node patch versions come from the supplied toolchains, not the latest `22.x`/`24.x`. The npm version is checked, not installed. |
| CI `check` aggregate | `contexts.check` (all seven `verify` jobs) | None. |
| CI `Web E2E / Node 22.x`, `Web E2E / Node 24.x` (15-minute timeout): browser install, workspace build, mocked browser run, evidence collection, full-stack run, evidence collection, evidence upload | `web-e2e-node22`, `web-e2e-node24` with the same steps, conditions and 15-minute limit | Browser system libraries come from host setup. Evidence is exported to the evidence directory instead of a 7-day artifact. A job without exported evidence fails, as with `if-no-files-found: error`. |
| CI `web-e2e` aggregate | `contexts["web-e2e"]` | None. |
| CI `Railway images`: `Dockerfile.api`, `Dockerfile.web`, `Dockerfile.backup` and two credential-free `--network none` smoke runs | `railway-images` | Builds use `--pull` and run-scoped tags. Image IDs are recorded and the images are removed afterwards. |
| CI `Postgres / Node 22.x`, `Postgres / Node 24.x` with a `postgres:17-alpine` service | `postgres-node22`, `postgres-node24` | Same image, credentials and health check on a random loopback port. |
| CI `postgres-integration` aggregate | `contexts["postgres-integration"]` | None. |
| Release `Verify tag and main ancestry` | `release-check` input validation | The runner supplies full history, the tag and a current main ref; the script does not fetch. |
| Release `postgres:17` service, `npm ci`, browser install, `npm run release:verify` with tag enforcement | `release` job steps | Same commands and environment. |
| Release image builds: root `Dockerfile` `api`, `mcp-http`, `web`; Railway API and web; backup image and smoke runs | `release` job `build-*` and `smoke-*` steps | Run-scoped tags; nothing is pushed. |
| Release `Upload release artifacts` | `verify-release-artifacts` step and `release/artifacts/` | Also checks that the artifact set is exact, that `SHA256SUMS` and the metadata match, and that the source archive rebuilds byte for byte from the pinned commit. |
| CodeQL `Analyze JavaScript and TypeScript`: `.github/codeql/codeql-config.yml` with `security-extended` | `codeql` mode | Uses the repository config plus `queries: - uses: security-extended`, and fails if an excluded query still reports. The number of findings does not gate; GitHub alert state, including dismissals, stays authoritative after upload. |

## Not Covered Here

These GitHub functions stay with GitHub, or with an external runner, until a separate cutover
replaces them:

- Pull request, push, tag and weekly CodeQL triggers, and release concurrency.
- Reporting the `check`, `web-e2e` and `postgres-integration` statuses, and branch protection.
- SARIF upload and the code scanning merge rule.
- Artifact retention.
- Dependabot, which is not an Actions workflow.

`scripts/check-prerelease.mjs`, `scripts/check-structure.mjs` and the release documentation
still describe the workflow files; update them when the workflows are retired. The full-stack
Compose run builds from cached base images without `--pull`, so the host cache can differ from a
fresh GitHub runner until it is refreshed.
