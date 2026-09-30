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

## Wave2 integration source state

Shared API production registration, CLI/MCP dispatch and browser entry paths are integrated on the roadmap candidate. Historical leaf-check receipts above remain historical and are not whole-candidate acceptance. Current Node22 source/narrow checks and parent canonical PostgreSQL/browser/image results are recorded in the wave2 build report.
Production uses backgroundScans and the durable worker starts after listen and stops before pool shutdown. Evidence DTOs retain digest, runner, attempt and failure code with legacy nulls. Completed-evidence trigger locking serializes concurrent finding insertion with scan completion. Version-aware eval expansion remains assigned to the next bounded worker.

Wave2 local proof: the21-test narrow integration selection includes worker batch deduplication and shutdown drain; the25-test Chromium selection covers actual pending wording and digest/attempt/failure display. Combined source build, web typecheck, lint and parity are checked in the wave2 report. The Postgres journey now also holds a real worker terminal write before commit and requires a concurrent late finding insertion to wait, then fail without changing completed evidence. This test is prepared for canonical CI and remains locally unexecuted.

## QUALITY-02 exact-version static evaluations

The API evaluates held, verified artifact bytes. It reuses `improvement_documents`
(kind `suite`) and immutable `improvement_document_revisions`; it does not add a
suite registry. Suites can include bounded static assertions with exact content
and rubric digests. Legacy provider suites remain readable, but cannot be used
as static suites without an explicit revision containing assertions.

Migration `0042_package_evaluations` adds completed, append-only evaluation
records. Each record binds the immutable version ID, artifact digest, existing
suite revision ID/document digest, platform and submission/release context,
runner `package-static/1`, actor and idempotency key. The review/lifecycle context
is captured by the server under the version locks. Concurrent identical writes
return one record; changed replay bindings conflict. Database triggers reject
updates, deletion and cross-artifact or cross-suite insertion. New suite revisions
and corrected skill versions create new evidence. Completed records are retained.

Assertions cover safe package structure/manifest and entrypoint presence
(installability), declared supported platforms (compatibility), the existing
admission risk scanner (safety), and exact protected file hashes (regression).
These are static checks, not successful installation on a real target or measured
model effectiveness. Behavior assertions always return `skipped` with
`provider_unconfigured`. Pass, fail, warning, skipped and incompatible counts
remain distinct. No package hooks, commands, scripts or providers execute.

Existing `improvements:run` and `improvements:read` scopes apply. The API retains
current account/credential/scope/role authority through completion, derives MFA
from the current credential for reviewer access to unpublished records, and uses
current registry permissions for evidence reads. Presented invalid credentials
fail closed, including on anonymous-capable summary routes. Private details do
not fall back to public summaries after denial. Static evaluation is advisory;
scan approval/publication gates remain mandatory.

CLI `evals local <directory-or-zip> --platform <name> [--suite <json>]` uses the
existing bounded snapshot/archive reader. JSON/human output is labelled
`self-reported`, contains no local path or package text, and never uploads.
`evals run <slug> <version> --input <json>` explicitly requests the authenticated
API evaluator. Existing improvement suite create/append commands manage suite
identities. A local report cannot approve or publish a version. MCP delegates the
same fixed API routes and scopes. Reviewer views show current authorized
assertions. Approved, published releases expose a bounded allow-list summary:
IDs/digests, runner, target, status and totals, without paths, findings, prompts,
raw task text or account data.

### Review remediation and legacy boundaries

Draft create/save now carry credential provenance past allocation/head waits,
retain current account and credential locks, and recheck scopes, role, expiry
and actual credential MFA before commit. Release forks retain teams' parent
organizations even for external team members. The draft UI remounts on connection
identity changes, invalidates old requests, and isolates tab recovery by registry
and connection epoch plus actor/draft identity.

Approval and publication require successful evidence for the exact current
artifact digest. New synchronous intake scans carry a digest and runner, insert findings before terminalization, and use the same completed-evidence immutability fences as background scans. The
explicit immutable `legacy_package_scan_allowances` migration captures only
unbound synchronous scans predating migration0039's recorded application time.
Fresh schemas without that historical journal admit no legacy exceptions. Later
null digests cannot enter the allowance or approve a version. Historical evidence
is retained without inventing retrospective digest provenance.

Canonical PG fixtures now include blocked draft create/save credential
revocation/expiry and valid controls, real parent-organization policy/archive
writers, consistent A-to-B metadata/payload drift at approval and publication,
completed finding update/delete/reassignment and insertion rejection, and an
actual production API process crash/restart/SIGTERM drain. They remain prepared,
not locally executed. Mini PostgreSQL/Docker and real Linux restore are outside
this worker's execution scope. Local source checks and final exact commits will
be recorded in `reports/quality-evals-build.md` after the architecture handoff.
