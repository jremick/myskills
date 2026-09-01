# Public Beta Delivery Brief And Acceptance Ledger

Version: 0.1.0-beta.3
Last updated: 2026-09-01

## Goal

Ship MySkills `v0.1.0-beta.3` for real external trial use with the Phase 2 architecture control plane, a self-contained public CLI package, explicit compatibility/support/upgrade boundaries, and a reproducible verification-only release workflow.

The beta remains prerelease software. It is not a business-safe production release and does not promise stable APIs, package formats, hosted signup, background processing, backup/restore, or incident-response coverage.

Target release: `v0.1.0-beta.3`.

## Release Outcome

Beta.3 is the current source and CLI release candidate. Publication requires a
clean canonical gate on the immutable merged commit, protected tag verification,
and read-back of the GitHub prerelease and npm `beta` dist-tag. Railway
production remains a separate approval and promotion boundary; the hosted
beta.2 deployment must not be described as beta.3 until API and web are promoted
from the same commit and verified live.

## Status Language

These terms describe the pre-release gate and are retained to explain how the acceptance ledger was closed.

- **Implemented**: the source, script, test, or document exists in this candidate branch; it is not a claim that default-branch or live proof is current.
- **Candidate proof required**: the final clean commit must produce fresh passing evidence.
- **Live readback required**: GitHub or Railway state must be inspected at approval time; local files are not authoritative.
- **Planned**: outside this beta acceptance boundary.

## Canonical Executable Gate

From a clean candidate checkout with dependencies installed, Chromium installed for Playwright, and `TEST_DATABASE_URL` pointing at a disposable database whose name includes `test` or `ci`, run exactly:

```bash
TEST_DATABASE_URL=postgres://myskills_test:myskills_test@localhost:5432/myskills_test npm run release:verify
```

`release:verify` runs the repo check (including ESLint, builds, web typecheck, unit tests, prerelease policy/version/link checks, and the packed public CLI smoke), route-mocked Playwright tests, a production-like Docker Compose API/web/MinIO/Postgres Playwright journey, disposable Postgres integration tests, and release artifact generation. Release docs may list narrower commands for diagnosis, but this is the single executable beta candidate gate.

The command intentionally fails when the worktree is dirty during final artifact generation. The tag workflow adds tag/version/main-ancestry checks and builds all Dockerfile targets after this gate.

## Acceptance Ledger

| Acceptance area | Required evidence | Release evidence |
| --- | --- | --- |
| Version and release contract | Root/workspace versions, API capability source, changelog target, beta goal, tag expectation, npm prerelease channel, and public dependency publishability agree | Candidate evidence required for protected tag `v0.1.0-beta.3` |
| Local onboarding | Fresh clone follows [Getting Started](GETTING_STARTED.md); root `.env` powers migrate, seed, API, web, and MCP dev scripts without shell sourcing | Passed in a clean Node 22 clone and the production-like full-stack gate |
| Public CLI package | Tarball contains only `README.md`, `dist/index.js`, and npm-generated `package.json`; clean temporary install runs `--version`, example `validate`, and example `scan`; no private runtime workspace dependency | Beta.3 candidate pack/install smoke required before npm publication |
| Static quality | ESLint 10 flat config, TypeScript builds, and explicit web typecheck pass on supported Node 22 and 24 LTS CI jobs | Passed on candidate, merged `main`, and tag workflow |
| Browser and database | Route-mocked Playwright, production-like full-stack Playwright through the nginx/API proxy, and disposable Postgres integration pass on the candidate commit | Candidate proof includes migrations 0015-0020 and the Phase 2 architecture journey |
| Public docs | README, setup, compatibility, API/MCP/CLI, architecture, data model, deployment, Railway, release, roadmap, support, security, contribution, and upgrade docs distinguish implemented/live/planned | Link/prerelease checks passed; live release status reconciled after promotion |
| GitHub controls | Required checks protect `main`; tag rules restrict creation/update/deletion; secret scanning, push protection, dependency security updates, and private vulnerability reporting are enabled where available | Live readback passed with administrator enforcement and high-or-higher CodeQL blocking |
| Distribution artifacts | Verification-only tag workflow confirms tag/version/main ancestry, reruns the canonical gate, builds production Compose API/web/MCP HTTP targets plus the exact Railway API/web Dockerfiles, and uploads source/checksum metadata without publishing | Tag workflow passed; GitHub prerelease exposes verified source, metadata, and checksums |
| Staging and user test | Same immutable commit is exercised through local production Compose or a dedicated staging environment; first-run, login/MFA, owner invitation and invitee registration, browse/detail, submit/review/publish, CLI validate/scan/search/export/install, MCP reads, and rollback notes are recorded | Passed against the immutable release commit in isolated staging; production public/browser/CLI smoke passed |
| External release actions | Tag push, npm beta publish, GitHub Release creation, container push, and Railway production deploy are separately approved; none is implied by a green local gate | Tag, npm beta publish, and GitHub prerelease are approved for beta.3; Railway promotion and container publication remain separate |

## Known Beta Limitations

- Hosted registration remains owner-controlled.
- Provider login/linking is not a complete external identity lifecycle.
- Background package scan jobs and durable eval runs are planned.
- Browser/device-code CLI login and platform-specific install adapters are planned.
- Production backup/restore and incident-response runbooks are not fully rehearsed.
- Container publishing and npm trusted publishing are not configured in the verification workflow.

These limitations are accepted only for external beta trial use. They remain blockers for the later business-safe release.

## Stop Rule

Do not tag or approve publication when any canonical gate step fails, candidate evidence comes from a different commit, live GitHub controls are unverified, staging/user-test evidence is incomplete, or a rollback owner is not named. Fix the candidate or record a narrower replacement release; do not waive the gate through documentation edits.

The staging, approval, tag, publish, production-deploy, and rollback boundaries are defined in [Release Process](RELEASE.md).
