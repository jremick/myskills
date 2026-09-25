# Beta.7 Release, Publication, and Staging Evidence

Version: 0.1.0-beta.7
Last updated: 2026-09-25
Status: verified candidate; GitHub release held as draft pending authenticated staging

This record tracks incomplete beta.7 delivery after [PR #84](https://github.com/jremick/myskills/pull/84). It keeps the beta.5 hosted baseline and the published beta.6 release historical. The current detailed release procedure remains in [Release Process](RELEASE.md).

## Candidate identity

- PR #84 is merged. The merge commit on `main` is `e99c0de7c4f400fc2b37dc51b4fd4a58766cc30c`.
- The immutable tag `v0.1.0-beta.7` resolves to candidate commit `6912d3f9490c6f002431f3064e8a9db417df3d7f`.
- The GitHub prerelease was published at `2026-09-25T06:00:53Z` and returned to draft later on 25 September after review found the sequencing deviation below. Current readback is `isDraft=true` and `isPrerelease=true`. It retains five verified assets: `myskills-app-0.1.0-beta.7-source.tar`, `release-metadata.json`, `SHA256SUMS`, `jarel-myskills-0.1.0-beta.7.tgz`, and `CLI-SHA256SUMS`.
- Published-asset digest and size readback matched the local release assets for all five GitHub assets.
- npm publication remains pending sign-in. The npm `beta` selector remains on `0.1.0-beta.6`; `latest` and `alpha` remain on `0.1.0-alpha.3`. Production remains on the beta.5 hosted baseline.

## Release sequencing deviation

The tag and GitHub prerelease preceded authenticated acceptance in the dedicated
Railway staging environment. This did not follow [Release Process](RELEASE.md#staging-and-user-test).
The passing disposable Compose journeys and public staging checks do not replace
that missing acceptance. No acceptance waiver is claimed.

The GitHub release was returned to draft. The source tag remains public and
immutable; no tag or archive was replaced. npm and production stayed unchanged.
Authenticated staging acceptance must be completed and recorded before GitHub
republication, npm publication, or production promotion. Those actions are
already authorized; missing authentication is the remaining dependency.

## Completed candidate evidence

The following evidence is recorded against candidate `6912d3f9490c6f002431f3064e8a9db417df3d7f`:

- The candidate readback contains 12 completed GitHub checks, all with `SUCCESS` conclusions. The candidate branch was reported mergeable and clean.
- Tagged release workflow [36100097156](https://github.com/jremick/myskills/actions/runs/36100097156) completed `SUCCESS` for exact candidate `6912d3f9490c6f002431f3064e8a9db417df3d7f`.
- The Windows-hosted Linux canonical gate passed with 1,138 repository tests, 230 Postgres tests, nine route-mocked browser tests, five full-stack browser tests, and zero failures.
- The tagged CI source archive matches the Windows source archive at SHA-256 `3a165e1d64ca3f8381273805af4f565dee11afa632d98a6019d3d6e3eb3c0031`. The verified CLI tarball SHA-256 is `6e4399d0051e945a019ae6816d0056f387de39ef6c4cb4b83f57984bb42fae21`.
- The published GitHub CLI asset passed the Windows smoke: its digest matched, a fresh-cache npm install succeeded, `--version` reported beta.7, the public example passed `validate` and `scan`, `init` created a scaffold, and two package ZIPs were byte-identical.
- The beta.7 staging API deployment `fabeef83-d999-4c46-aac8-1b026a88e52f` and web deployment `af63dfdc-54a0-40fe-ab6c-a48d3f6866ce` both succeeded. API, web, and same-origin version readbacks expose the same candidate revision.
- Staging public checks rendered the catalogue, a version selector showing one visible version, and package files as literal text. Historical-version selection was not tested. The Windows CLI checks for `doctor`, `export`, `validate`, and `scan` passed.
- Anonymous staging access to `/v1/mcp/session` returned the expected `401 AUTHENTICATION_REQUIRED` response.

## Recovery and compatibility evidence

The maintainer-only release evidence bundle contains these completed reports (`capture-result.json`, `restore-result.json`, `migration-runtime-result.json`, and `runtime-compat-result.json` under `.private/windows-release`):

- A fresh coordinated capture passed with 50 tables, 87 artifacts, 86 object-backed artifacts, 3,394,519 artifact bytes, and no source writes.
- An isolated restore of that capture passed with the same table, artifact, object-backed artifact, and byte counts, with no source writes. The restore report marks application-runtime restoration as `not-tested`; this is data-restore evidence only.
- Candidate migration and runtime readiness passed for candidate `6912d3f9490c6f002431f3064e8a9db417df3d7f`. The report found 32 migrations, including `0029_architecture_sync_history_retention`, `0030_architecture_pattern_migration_diff_shape`, and `0031_auth_notification_outbox`; Postgres, artifact storage, and phase-two architecture readiness all reported `ready`.
- Legacy runtime compatibility readiness passed against the beta.5 production revision `d8c7179789bdbf0930fe0e496081377f6c63cd20`, with HTTP readiness and the Postgres, artifact-storage, and phase-two architecture checks ready. This is compatibility evidence; it is not a completed live rollback.
- All five task containers, six task image tags, and the task-owned Windows working directory were removed after verification. All four pre-existing containers were preserved.

Account-bearing browser reports, recovery contents, and private package identities remain outside the public repository. The public record carries the result summaries only.

## Pending release gates

- Authenticated staging acceptance remains pending owner sign-in. The staged public checks do not establish the authenticated author, reviewer, consumer, or owner journey.
- GitHub republication and npm package publication remain pending. npm also requires renewed maintainer authentication. The `beta`, `latest`, and `alpha` selectors remain unchanged.
- Beta.7 production API/web promotion remains pending. Production remains on the beta.5 hosted baseline until authenticated staging acceptance passes. Production promotion is already authorized.

## Rollback limitation

Fix-forward is preferred. The legacy readiness report supports compatibility
review and rollback planning only; it does not prove a full rollback. No live
rollback was executed. The recovery runtime did not verify the historical auth
secret or notification delivery. Any actual rollback requires full flow evidence
before use.

## Scope boundaries

Beta.7 delivers deterministic local authoring, authorized native MCP Skills delivery, release-history navigation, and the reviewed registry and deployment repairs. Native model-selected host activation, folder/ZIP or GitHub imports, browser drafts, and guided self-hosting setup remain roadmap work. See [Authoring and native MCP delivery](AUTHOR_MCP_DELIVERY.md) and [Roadmap](ROADMAP.md).
