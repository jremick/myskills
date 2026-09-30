# Local CI And Release Checks

`scripts/local-ci.sh` runs the same gates as the GitHub Actions workflows on a Linux host with
Docker. Contributors can use it before opening a pull request. An external runner can call it
after checkout and read its evidence. Release and merge instructions use its results. The GitHub
workflows stay in the repository as a parity reference during the migration. This entrypoint
does not report statuses or publish anything.

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

On a Linux/amd64 worker sized for the complete matrix, opt into the measured four-lane plan:

```bash
LOCAL_CI_VERIFY_LANES=4 scripts/local-ci.sh verify
```

The default is serial. The four lanes are browser Node 22; browser Node 24; PostgreSQL then check
Node 22; and PostgreSQL then check Node 24 then Railway images. Each lane waits for its current
job's cleanup before starting the next job. A job failure does not suppress the other required
jobs. Cancellation stops all active steps and skips queued jobs. Release checks and CodeQL stay
serial. Four-lane execution does not change the seven-job gate, source checks or result contract.

Keep the external worker's global job lock around the whole invocation. The four-lane measurement
does not justify concurrent app runs or additional lanes. Set `LOCAL_CI_VERIFY_LANES=1`, or remove
the variable, to roll back to serial execution without changing any gate.

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
| `LOCAL_CI_EVIDENCE_DIR` | Required. Absolute, outside the source tree, not a symbolic link, and absent or empty. Every file in it is scanned and exported, so a populated directory is refused. |
| `LOCAL_CI_SOURCE_SHA` | Optional. Must equal `HEAD`. Without it the result is not gating. |
| `LOCAL_CI_VERIFY_LANES` | Optional: `1` (default) or `4`. Four lanes are accepted only for `verify`. Partial selections use the same lanes and remain non-gating. |
| `LOCAL_CI_NODE22_BIN`, `LOCAL_CI_NODE24_BIN` | Directories containing `node`, `npm` and `npx`. When unset, `node` on `PATH` is used only for its own major version. |
| `LOCAL_CI_WORK_DIR` | Optional parent for the per-run workspace. Defaults to the OS temporary directory. |
| `DOCKER_HOST`, `DOCKER_CONTEXT` | Jobs that use Docker need a local `unix://` endpoint; a remote endpoint is refused. Set at most one of the two, because `DOCKER_CONTEXT` overrides `DOCKER_HOST`. |
| `LOCAL_CI_RELEASE_TAG`, `LOCAL_CI_MAIN_REF` | `release-check` only. The tag must be `v<package version>` and point at `HEAD`. `HEAD` must be an ancestor of the main ref (default `refs/remotes/origin/main`). The script does not fetch. |
| `LOCAL_CI_CODEQL_BIN`, `LOCAL_CI_CODEQL_CATEGORY` | `codeql` only. The category defaults to `/language:javascript-typescript`. |
| `MYSKILLS_E2E_PORT`, `MYSKILLS_E2E_WEB_PORT`, `MYSKILLS_E2E_MAILPIT_PORT` | Optional loopback ports. Free ports are chosen when unset. With four lanes and both browser jobs selected, overrides are refused and all six selected ports are distinct. |

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
- `gating` and `gatingBlockers`: only a complete job set with a verified `LOCAL_CI_SOURCE_SHA` on a
  Linux/amd64 host can gate a commit. Other hosts report `unsupported-host-platform`.
- `contexts`: for a complete `verify` run, the protected-branch contexts `check`, `web-e2e` and
  `postgres-integration`. Partial runs report `null`.
- `jobs`: status, reason, steps, exit codes, timings and a hashed log for each job.
- `cleanup` and `artifacts`: cleanup outcome and the SHA-256 of every evidence file.

Other evidence: `logs/<job>.log`, `resources.json`, `environment.json`,
`browser-evidence/<job>/` (including separate `fullstack` and `fullstack-connector` summaries and the reviewed screenshots from
`scripts/collect-browser-evidence.mjs`), `release/` (verified artifacts and
`verification.json`) and `codeql/` (SARIF and a summary).

Credential-shaped output is replaced with `[redacted]` in logs and fails the run. The full-stack
runner also redacts its generated credentials. Raw Playwright reports, traces and videos stay in
the job clone and are deleted with it.

## Isolation And Cleanup

Each job runs in its own clone of the pinned commit inside
`<work dir>/myskills-local-ci-<run id>`. Before that, the run ID is reserved by creating
`/var/tmp/myskills-local-ci-locks/<run id>` exclusively, whatever `TMPDIR` or the work directory is,
so two runs on one host cannot share a run ID. The lock directory must be owned by the running user
and not writable by others. The reservation covers only this host's Docker daemon, which is why
remote Docker endpoints are refused. A reservation is never taken over. The script records each container, Compose project and image in
`resources.json` before or as it creates it, and removes only those exact names. Compose cleanup
matches the exact `com.docker.compose.project` label. A container whose creation failed, for
example because of a name conflict, is never removed. The script never prunes and never matches
name prefixes. Shared npm, Playwright and Docker build caches are kept.

Four-lane jobs also receive separate `HOME`, `TMPDIR` and XDG directories in exclusively created,
ledger-recorded directories below the runner's temporary directory. Use a short runner `TMPDIR`
because some test tools create Unix sockets there. These private directories are removed with
their job's resources. Explicit npm and Playwright cache paths remain available through the
environment allowlist. Docker uses the caller's original configuration directory, resolved to an
absolute path even when it was implicit under `HOME`, so preflight, jobs and cleanup select the
same context. Its contents are not copied. Browser ports are selected once per job and are
never reused by another job in that run; unrelated host processes can still claim a free port
before a browser starts, which fails the affected gate.

Each step runs in its own process group. `SIGTERM` stops all active steps, cleans up and writes a
cancelled result; allow about 60 seconds. The reservation is released only after complete cleanup.
If cleanup fails, or after `SIGKILL`, the reservation stays and the run ID is refused. To recover,
remove the resources listed in that run's `resources.json`. Then remove
`/var/tmp/myskills-local-ci-locks/<run id>` only if its `owner.json` `owner` equals the
`run-id-reservation` entry's `owner` in the same `resources.json`.

## Maintainer Controller

Maintainers dispatch this entrypoint to a trusted Linux host with a private `local-ci` controller.
The controller snapshots the exact commit, runs the entrypoint, collects `result.json` and the
evidence, and reports the protected contexts. Contributors do not need it. Dispatch only trusted
changes. The syntax below is current; final paths and configuration may still change.

```bash
local-ci submit --app myskills --job verify --commit <sha>
local-ci submit --app myskills --job release-check --commit <sha> --tag v<version>
local-ci submit --app myskills --job codeql --commit <sha>
local-ci wait <run-id>
local-ci report --app myskills --commit <sha>   # dry run; --execute posts statuses
local-ci sarif upload <run-id>                  # dry run; --execute uploads SARIF
```

The controller can enable the four-lane plan by setting only its MySkills `verify` job environment
to `{"LOCAL_CI_VERIFY_LANES":"4"}`. Keep its current global worker lock, required checks, result
adapter, source/trust checks and timeouts. Activate this after the worker has verified the
entrypoint version with four-lane support; older commits ignore the variable and run serially.
Read back the dispatched request, `environment.json` (`verifyLanes: 4`), all seven job results and
the aggregate contexts before treating activation as verified.

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

The entrypoint does not provide these functions. Until cutover, GitHub Actions and repository
settings provide them; afterwards the maintainers' controller and GitHub settings do:

- Pull request, push, tag and weekly CodeQL triggers, and release concurrency.
- Reporting `local-ci/check`, `local-ci/web-e2e` and `local-ci/postgres-integration` after the matching branch-protection cutover. These distinct names replace the Actions contexts `check`, `web-e2e` and `postgres-integration`.
- SARIF upload and the code scanning merge rule.
- Artifact retention.
- Dependabot, which is not an Actions workflow.

The workflow files stay as the parity reference, so `scripts/check-structure.mjs` still requires
them and `scripts/check-prerelease.mjs` still checks their static contract. Remove those checks
only together with the files. The full-stack Compose run builds from cached base images without
`--pull`, so the host cache can differ from a fresh GitHub runner until it is refreshed.

## Updating an existing branch

Merge or rebase an older branch onto current `main` before requesting local checks. The controller
runs the checked-out commit's entrypoint, so a branch without `scripts/local-ci.sh` fails closed.

Wait for fresh `local-ci/check`, `local-ci/web-e2e` and `local-ci/postgres-integration` results on the
current pull request head, and for the code-scanning rule to accept its CodeQL analysis. Updating
either the head or its base invalidates evidence for the earlier merge source. Fork contributions
require maintainer review before their code runs on a trusted worker.
