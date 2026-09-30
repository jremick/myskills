# Package Quality Delivery

Status: source implementation and review in progress. Postgres verification pending. No deployment or release evidence.

## First slice: durable scans

The API owns admission, immutable package artifacts, scan evidence, review, and publication. The existing synchronous admission scan remains mandatory. Postgres intake additionally queues a digest-bound confirmation scan in the existing jobs table, in the same transaction as the version and artifact. The production server enables this path; the store's default synchronous mode preserves embedded callers until they adopt the worker. Queued submissions use the existing `not-run` security state and expose `queued` or `running` through scan history.

Acceptance: a multi-file submission stays pending until the worker completes. Concurrent workers claim one job. An expired lease creates a fresh attempt, and stale results cannot commit. Retries and completed findings remain inspectable after restart. Exhausted or tampered artifacts fail closed. A corrected version can pass and be approved without changing earlier published artifacts. Author/reviewer routes gate detail; public release metadata contains no paths or findings.

## Failure cases recorded before implementation

1. Intake, job enqueue, artifact write, or database commit fails halfway through.
2. Concurrent intake creates two jobs for the same artifact and runner.
3. Two API replicas claim the same queued job.
4. A worker crashes before completion; restart never recovers the job.
5. An expired worker finishes after a replacement and overwrites its result.
6. Retry limits are reset by restart, or retries overwrite previous findings.
7. The artifact body, digest, manifest, or size changes after intake.
8. A withdrawn/deleted or already approved version is mutated by a worker.
9. Pending, failed, or warning evidence enables approval or publication.
10. A correction mutates a prior version or its approved digest.
11. Storage errors or scan findings leak raw package content through logs/audit/public metadata.
12. Worker shutdown closes the database while a claim is still completing.

Primary verification will be a Postgres/API journey with real store transactions, concurrent claims, retry exhaustion, stale completion, integrity rejection, correction, publication, and access denials. Existing synchronous route and artifact tests cover admission; they cannot establish leases or restart persistence. The new journey uses production claim/process/complete boundaries, not a mocked queue.

Risk: Tier 3 (untrusted packages, persistent records, review gate). No new dependency, provider execution, credential path, release version, or automatic publication. Rollback: disable the poller and retain queued records; additive schema stays readable. Pending submissions need the worker to complete before approval.

## Operator contract

- Apply migration `0039_package_scan_jobs` before starting the new server.
- The production worker polls the existing jobs queue. Multiple API processes can run it; `FOR UPDATE SKIP LOCKED` claims one job and a random lease fences completion.
- Each lease lasts two minutes. An interrupted attempt becomes a failed immutable record and a retry gets a new scan ID. Three attempts are permitted, with bounded retry delays. Storage unavailability can retry; integrity failures and inactive versions fail closed.
- `PACKAGE_SCAN_WORKER=disabled` pauses polling for maintenance. Intake continues to queue, and approval stays blocked. Restart with polling enabled to recover queued or expired claims; do not clear attempt counters or replace artifact bytes.
- The author and maintainer evidence routes show attempt, runner, digest, failure code, and findings under their existing authorization. The browser offers explicit refresh. Public release metadata omits findings and paths.
- Worker error logs contain a fixed message. Audit entries contain bindings, counts, and fixed failure codes, never raw storage errors or package content.

## Verification ledger

| Claim | Evidence | Current result |
| --- | --- | --- |
| Synchronous admission, author/reviewer gates and feedback remain compatible | Existing submission, review and feedback suites | 45 tests passed on Node 24 |
| Package/API/CLI/MCP/web source builds | `npm run build` | Passed |
| Web contracts | `npm run typecheck -w @myskills-app/web` after workspace build | Passed |
| Mobile attempts, full digest wrapping and explicit refresh | Mocked browser journey in `author-review-redesign.spec.ts`; screenshot inspected | Passed; UI fixture evidence only |
| Operational destination/privacy guardrails | `operational-safety.test.mjs` | 7 tests passed |
| Privacy and source secret checks | `check:privacy`, `scan:secrets` | Passed |
| Lease/restart/immutability/durable corrected-version acceptance | `package-quality-journey.pgtest.ts` | Pending coordinated Postgres run |
| Shared inventory and source anchors | `check:parity` | Pending shared wiring slot |

Independent native reviewers inspected queue correctness and migration/security boundaries. Corrections cover manifest identity for object-backed payloads, compatible version/FK locks, actual-time lease checks after lock acquisition and at completion, completed finding insertion/reassignment, and explicit non-null evidence bindings. This review is source evidence; it does not establish Postgres execution.

## Remaining QUALITY work

Version-aware deterministic eval suites and runs must bind exact release/artifact, runner, and target. Reuse improvement suite/run contracts; keep fail, warning, skipped, and incompatible distinct. Provider or paid execution remains disabled without explicit configuration and budget. Reviewer evidence and public-safe summaries follow the API authority. Milestones 3/6/9 remain incomplete until their runtime acceptance is proved.
