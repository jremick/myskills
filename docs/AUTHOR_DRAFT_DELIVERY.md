# AUTHOR-1 delivery evidence

Prepared: 2026-10-01
Base source: `c74ecd33ce987d24ef5ddf40a0fef98f1a50fc9b`
Status: wave2 source integration complete with bounded local Node22 and Chromium checks. PostgreSQL, full-stack, connected-host, release and deployment acceptance remain separate gates.

The [implementation plan](plans/2026-10-01-author-drafts.md) and [API contract](plans/2026-10-01-author-drafts-contract.md) define private multi-file workspaces, saved history, stale-edit recovery, held-file imports, exact-source forks and correction through new immutable submissions. The API, browser and adapter work use distinct file ownership.

Shared API/store/services, CLI dispatch, MCP schemas/actions and browser registration are integrated in wave2. Immutable saves/history/diff/OCC and safe folder/ZIP preview reuse the API permission authority. Draft submission refreshes history and clears the previous archive receipt. Production queues a digest-bound confirmation scan and reports queued/not-run until the worker completes. Retry replay selects the latest applicable attempt.

Source forks verify held canonical bytes and retain source, team/organization and lifecycle authority through persistence after allocation waits. Canonical PostgreSQL regressions include concurrent saves/submits, expired-scan replay, rollback, correction and private source byte identity. Their execution remains for the parent controller.

## Verification ledger

| Boundary | Evidence | Result |
| --- | --- | --- |
| Supported local toolchain and dependencies | Node 24.19.0, npm 11.12.1; `npm ci` from the existing lockfile | Passed; 386 packages installed and zero reported audit vulnerabilities. This is setup evidence only. |
| Declared workspace prerequisites | `npm run build -w @myskills-app/core -w @myskills-app/auth -w @myskills-app/skill-package` on Node 24 | Passed; enables tests through the actual workspace exports. No draft runtime claim follows from these builds. |
| API contract and failure inventory | API contract written before production implementation | Prepared; real PostgreSQL execution remains pending. |
| Browser acceptance | `apps/web/test/e2e/fullstack/author-drafts.spec.ts`, prepared before browser implementation | Test preparation only; not executed. |
| API persistence | `apps/api/test/drafts-journey.pgtest.ts`, prepared before API implementation | Test preparation only; not executed. |
| CLI/MCP adapters | `apps/cli/test/author-draft-parity.e2e.test.ts` and `apps/mcp/test/author-draft-schema.e2e.test.ts`, prepared before adapter implementation | Loader prerequisites resolved; intended-failure controls and candidate checks pending. |
| Required exact-candidate matrix | Supported Node 22/24 repository, PostgreSQL, browser and image gates | Pending coordinator scheduling after candidate preparation. |
| Independent review | Correctness, private-data boundaries and unsafe intake | Pending implementation. |

## Published-version comparison (HIST-01)

The current source supports selecting exact published versions, preserving version URLs and browser history, showing per-release notes, lifecycle, digest and export guidance. `apps/web/test/e2e/release-history.spec.ts` verifies those behaviors against controlled API responses. It does not compare two packages or prove persisted release comparisons.

The release comparison browser now uses both exact authorized bundle reads and checks their digests, package manifest identity and complete file contents. It shows added/removed/modified/unchanged files without changing the pinned URL. Dedicated CLI/MCP comparison remains partial; their exact exports are available. Browser fixture and canonical exact-version authorization tests are prepared. No real PostgreSQL or deployed comparison proof is claimed by source registration.

## Wave2 local verification

The combined eight-workspace build, web typecheck and capability gate pass on Node22.23.2. Draft CLI/MCP transport tests pass within the21-test narrow integration suite. The143-test web DOM/API selection passes. The25-test affected Chromium browser selection includes queued draft history, archive-receipt clearing even when history fails, pending archive wording, and exact release comparison. Comparison also has a real AuthService/API memory journey for two exact private published versions, denied foreign/anonymous reads, stale digests and revoked credentials. These are bounded local proofs, not PostgreSQL or real-host acceptance.

Canonical CI will execute the real queued draft/retry/correction journey, concurrent OCC/submit rollback, allocation-wait membership removal, and changed database-backed source-byte denial. No PostgreSQL run was performed locally in this wave.
