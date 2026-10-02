# AUTHOR-1 draft API contract

Prepared before production implementation on 2026-10-01.

All routes are private to the authenticated user. Draft reads require `submissions:read`; mutations and preview require `skills:submit`, an author-capable role, and the existing privileged-role MFA policy. Release sources additionally require `skills:read`; submission sources additionally require `submissions:read`. Foreign users and maintainers receive `404 DRAFT_NOT_FOUND`.

| Action ID | Method and path | Request | Response |
| --- | --- | --- | --- |
| `draft.list` | `GET /v1/drafts` | none | `{drafts: DraftSummary[]}` |
| `draft.create` | `POST /v1/drafts` | `{title,files}` or `{title?,source}` | `201 {draft}` |
| `draft.get` | `GET /v1/drafts/:id` | none | `{draft}` |
| `draft.update` | `PUT /v1/drafts/:id` | `{expectedRevision,title,files}` | `{draft}` |
| `draft.history` | `GET /v1/drafts/:id/history` | none | `{revisions: DraftSummary[]}` |
| `draft.revision` | `GET /v1/drafts/:id/revisions/:revision` | none | `{draft}` |
| `draft.validate` | `POST /v1/drafts/:id/validate` | `{expectedRevision}` | `{validation}` |
| `draft.preview` | `POST /v1/drafts/preview` | exactly `{files}` or `{archive:{filename?,contentBase64}}` | `{preview}` |
| `draft.submit` | `POST /v1/drafts/:id/submit` | `{expectedRevision,release?}` | `202 {draft,submission}`; completed-revision retry `200` |

`Draft` is `{id,title,revision,files,source,createdAt,updatedAt,submission}`. Files are `{path,content}` text records. `source` is null or `{kind:'release',slug,version,platform?,artifactSha256}` or `{kind:'submission',submissionId,slug,version,artifactSha256}`. `submission` is null or `{id,slug,version,artifactSha256}`. `DraftSummary` omits `files` and adds `fileCount,textBytes`. Snapshot history is newest first.

`validation` is `{valid,manifest:null|SkillManifest,issues:[{code,message,path?}],findings:ScanFinding[]}`. Structural invalidity rejects intake; incomplete or invalid manifests save and produce diagnostics. Blocking scanner findings make `valid` false. `preview` is `{files,validation,fileCount,textBytes}`. Content is never executed.

The returned `submission` is `{id,slug,version,artifactSha256,lifecycleStatus,reviewStatus,securityStatus,scan:{status,findings,findingCount}}`. Preserve the service's actual scan and security status; scan completion is independent of workspace submission.

Titles contain 1–120 characters. Revisions are positive safe integers. The head check fails with `409 DRAFT_REVISION_CONFLICT`. Intake uses canonical package path/text checks, 500 files, 1 MiB UTF-8 text, and 10 MiB compressed ZIP. Draft mutation/preview bodies allow 14 MiB JSON. Unknown fields fail with `400 INVALID_DRAFT_INPUT`. Limits refuse without pruning: `409 DRAFT_LIMIT` at 100 drafts per author, `409 DRAFT_HISTORY_LIMIT` at 100 snapshots per draft.

Every explicit save creates the next immutable snapshot and clears that head's submission binding; previous submitted snapshots retain their receipt. Submission atomically checks the current revision and digest and records its receipt inside the registry submission transaction. Duplicate-version or transaction failures leave no partial receipt. Concurrent completed retries return the original submission. Release forks preserve exact permitted source files; source access and digest are rechecked before persistence. Reading a foreign slug does not grant its ownership.

## Failure inventory and test gate

The acceptance test protects independent route, persistence and authorization contracts. Existing registry tests do not exercise draft state or revision linking. No production-only test hooks are required: concurrency uses real row locks, and rollback uses a disposable Postgres trigger.

- A multi-file invalid manifest saves, reloads and remains immutable after correction; support files and license remain exact.
- Foreign authors and maintainers cannot read, save, inspect history, validate, submit or seed another user's submission.
- Missing scopes, missing author roles and privileged writes without MFA fail before mutation.
- Two saves from one revision produce one winner; stale validate and submit refuse.
- Save/submit races and concurrent submit retries cannot bind the wrong head or create duplicate versions.
- Feedback correction submits a new version; original artifact bytes and older snapshot receipts remain immutable.
- Duplicate slug/version and a failure after version insertion roll back both registry version and draft receipt.
- Validation reports manifest errors and blocking secrets; submission retains its unsafe-content hard gate.
- Traversal, portable collisions, NUL, invalid UTF-8, oversized text/files/archive, ZIP symlinks and mixed preview input refuse.
- Draft/history limits refuse explicitly without changing retained history.
- Exact release and own-submission forks preserve bytes and attribution. Source revocation while object bytes are read prevents draft persistence.

Verification status: the failure inventory and `apps/api/test/drafts-journey.pgtest.ts` were written before production code. The dedicated module passes the Node 24 API build and scoped ESLint checks. App/server wiring is waiting for the coordinated shared slot. Real Postgres execution belongs to the coordinator's exact-candidate CI run; no persisted acceptance claim is made yet.
