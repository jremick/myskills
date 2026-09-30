# AUTHOR-1 delivery evidence

Prepared: 2026-10-01
Base source: `c74ecd33ce987d24ef5ddf40a0fef98f1a50fc9b`
Status: implementation in progress. No AUTHOR-1 runtime, release or deployment completion is claimed.

The [implementation plan](plans/2026-10-01-author-drafts.md) and [API contract](plans/2026-10-01-author-drafts-contract.md) define private multi-file workspaces, saved history, stale-edit recovery, held-file imports, exact-source forks and correction through new immutable submissions. The API, browser and adapter work use distinct file ownership.

Shared wiring is held while the coordinator advances other ready workstreams. The browser's initial `App.tsx`/`api.ts` authoring hunks are preserved and frozen. API and adapter registration hunks are not yet applied. Dedicated draft modules, browser components and acceptance tests continue independently. The authoring migration slot is `0037_author_drafts.sql`. Existing submission hooks remain the transaction boundary; queued confirmation scans from the quality workstream must remain visibly pending until actual completion.

When the AUTHOR slot returns, the browser submission callback must refresh history and clear the old archive receipt. The new workspace displays its own receipt with the service's actual scan status. Reusing the old archive summary would incorrectly call an empty, queued scan ready for review.

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

No published package comparison implementation was found in the directly relevant registry components or submission API. The roadmap still lists version comparison as open. Private draft revision comparison in this slice must not be used as evidence for published-version comparison. HIST-01 remains an explicit integration acceptance gap for the coordinator to assign after the shared authoring slot is released.
