# Roadmap candidate delivery

Recorded 1 October 2026. Source version: `0.1.0-beta.19` in the root, every npm workspace and lockfile. The preserved beta.18 and earlier release records describe their dated releases. This candidate has no release, deployment or production acceptance.

The final source descends from frozen QUALITY base `8ba7e0eaa62ddbdb127cc009cc0057ad0cf1f248` and exact combined dependency `097cd50db075e691fb8d535601b4560ba0cdbfe2`. Final commit identity belongs in the root handoff after this document is committed. This document deliberately contains no self-referential final SHA.

## Current delivery

The API owns state and permission decisions. CLI and MCP reuse authorized API reads and mutations. Architecture reviews remain permanently non-executable; composed artifact execution has a distinct immutable purpose, execution approval, current consent/generation/policy checks, shared target lease, actor/fence-bound checkpoints and receipts, and explicit rollback approval. The composed skill-set product thesis remains intact. Broader provider adapters and signed-in host recognition require their own acceptance.

Five QUALITY review corrections are included:

- Evaluation evidence defaults to private. Detail requires both exact-release access and the canonical suite-scope contract. Explicit public-summary disclosure requires current public-release sharing authority, applicable MFA and scoped credentials; summaries omit suite identity, suite digest and assertion details. Current release/discloser authority is rechecked on read.
- Draft submit checks current submit authority after the draft-head wait and after submission/version allocation. Denial leaves no version, job or submission receipt. Accepted create/save and organization fork-policy locks are retained.
- Private Library self-review and instance elevation consume a successful scan for the exact current artifact digest. Real PostgreSQL fixtures prepare consistent payload/digest A-to-B drift denial and corrected-version success.
- Organization-owned team suites require current organization membership even when external release sharing permits an external team member. Suite GET and evaluation use one access contract.
- Idempotent evaluation replay checks actual-time credentials after waiting on the suite row. The fixture expires a credential after its initial authorization and observes the exact SQL wait.

Local evaluation continues to accept hardlinked regular files within the existing bounded reader. No unrelated package reader or package-code execution was added. Provider behavior remains explicitly skipped when unconfigured.

HIST-01 now has `myskills skills compare` and `skills_releases_compare`. Both select two distinct exact published releases, require current API read authority for each, verify SHA-256/byte size/path/manifest identities, compare full content deterministically, and return added, removed, modified and unchanged files. Previews have explicit per-file and aggregate bounds and truncation. Final authority reads precede output. Management-only access cannot read unpublished releases. A named real-PG fixture prepares the two-published-release journey, private and management denial, wrong pins/foreign identity and revocation after both metadata/bundle pairs; it is strictly compiled and unrun locally.

Reviewer comparison also uses the existing review-detail/package and independently authorized published-release primitives: `myskills review compare`, `review_submissions_compare`, and the review inspector. Candidate inspection does not approve or publish. API reviewer/MFA checks cannot bypass baseline release visibility. Local contracts include final revocation, wrong pins/identities, unavailable baselines, long-content differences and stale browser responses; the real-PG reviewer journey remains prepared.

## Architecture review follow-through

The independent review at exact097 accepted approval metadata, post-wait maintenance windows and final credentials/MFA, actor/fence binding, and directory durability at source level. Its seven additional findings receive these source corrections:

| Finding | Current correction | Acceptance still required |
|---|---|---|
| Global generated step-ID collision | New requests namespace generated IDs before plan digests. Existing nonempty `step-N` requests recompute immutable inputs using stored IDs under current authority; store digest checks decide replay | Distinct/concurrent plans, legacy replay and fresh-store real-PG readback |
| Plan fixture never reached lock | Valid bearer; early HTTP completion reports status; exact blocking PID retained; valid consent transition and complete restore | Actual retained authority and rollback journeys |
| Obsolete observation fixtures | Historical rows seeded before 0034, all current migrations before journal use; separate current legacy-rejection/canonical normalized positive | Full SQL journeys, including historical preservation |
| Workspace enrollment race/traversal | Shared protected OS-user enrollment index/lock spans reservation, API registration and durable binding/index writes; normal profile/config directories do not split it | Canonical process/workspace workflows and independent source review |
| Backup DNS inaccessible to host recovery | Exact owned bridge gateway/IPAM/container ownership and assigned port read back; TLS IP SAN; one gateway-bound endpoint | Actual bucket, backup and host-network recovery on Linux |
| Ambiguous image receipts | Explicit linux/amd64 inspect/push and manifest-vs-config identity handling; fixed safe image-role/check/fetch failure categories | Next actual Docker28 receipt and complete HOST rehearsal |
| Tamper test did not prove no dispatch | Command recorder rejects all downstream image build/smoke dispatch after failed provenance, with successful observing control | Canonical controller execution |

## Local enrollment state and migration

The enrollment index uses the existing private MySkills state/lock/no-follow/atomic-write conventions. It is shared at `.config/myskills-app/workspace-enrollments` under the actual OS account home returned by `os.userInfo()`. `HOME`, `XDG_CONFIG_HOME`, registry URL, `MYSKILLS_CONFIG_DIR` and named profiles cannot select a separate authority. Other CLI configuration keeps its existing environment conventions. Tests inject a temporary runtime directory. Absolute paths and inode/binding identities stay local and are not sent to the registry.

The selected previous XDG/home index is a read-only migration source. Under the common lock, compatible records and interrupted reservations are merged without deleting stale disjoint reservations or rewriting the old file. Conflicting inode or binding identities deny. Pre-index binding discovery remains required when a previous index is not selected. Local real-process tests cover distinct XDG roots in both overlap orders, exactly one registration, a disjoint positive and interrupted recovery.

A new or pre-index enrollment performs a one-time legacy-binding discovery while holding the same enrollment lock. It validates real binding schema, target/provenance and canonical root identity; marker presence does not establish enrollment. It does not follow symlinks or enter `.agents/skills` or `.claude/skills` discovery trees. Permitted legacy roots under `.agents/project` or `.claude/project` remain visible to this check. Unreadable unrelated subtrees remain untouched. Current indexed install, update, rollback and companion commands do not recursively scan arbitrary projects. Valid pre-index children deny first parent enrollment before adoption.

Reservations are persisted before registration; interrupted enrollment resumes at the same root. Missing or unreadable disjoint recorded roots retain reservations and do not disable unrelated workspaces. An overlapping reservation, substituted selected root, changed binding or manually moved binding denies and requires explicit local recovery. Preserve the private index and bindings; restore the original root/identity or reconcile ownership under the same shared lock after independently establishing that no active enrollment owns the reservation. There is no automatic discard/rebind. The CLI serializes cooperating commands; arbitrary manual filesystem changes or another same-user process can evade that coordination and are outside its isolation claim.

## Schema and compatibility

Run the maintained migration runner in lexicographic filename order through 0042. Do not order solely by numeric prefix: 0009, 0010, 0032, 0034 and 0035 each contain multiple migrations. The existing0012/0013 legacy artifact ambiguity preflight must succeed before backfill. Current migrations include architecture/organization/target/sync/pattern history, immutable observations, Library/improvement/bundle/GitHub/OAuth ownership, notification outbox, author drafts, device login, scan jobs, review history, composed artifacts, and package evaluations.

`0034_observation_slug_privacy.sql` preserves existing historical rows while rejecting newly inserted obsolete snapshots. New target observations use the normalized envelope and canonical target-observation digest. `0041_composed_architecture_artifact.sql` binds composed purpose and immutable intent/approval evidence. `0042_package_evaluations.sql` binds evaluation artifact/suite identities, private disclosure and immutable results; it freezes only explicitly admitted pre-0039 synchronous scans as legacy allowances. Historical scan allowances cannot follow later artifact drift.

`0042_package_evaluations.sql` is an unreleased candidate migration amended before first canonical acceptance. An environment that already applied an earlier working 0042 must use a fresh disposable candidate schema or a separately reviewed forward migration before adopting this source. The runner must not silently treat that earlier table shape as updated. Production or persisted development databases are not reset by this task. Backup/restore acceptance must preserve the complete application state, not Git-only history.

## Verification and remaining acceptance

The original 426 IDs/text/source identities/captured hashes and 24 backlog groups are preserved. `roadmap-criterion-bindings.json` contains separate current source/check/status/gap bindings. `reconcile-roadmap-criteria.mjs --check`, also run by `check:structure`, verifies immutable baseline constants and exact current anchors/hashes. No criterion becomes complete merely because a fixture file, parity cell or aggregate suite count exists. Local receipts refer to particular working-source checks; unrun fixtures remain prepared.

The exact097 integrated Windows diagnostic failed all seven jobs and did not reach final fullstack/site or complete HOST restore. The later exact5128 run finished on 1 October 2026: both general checks passed; PostgreSQL had 306 passes and six failures per Node lane; mocked browsers had 193 passes and one skip; fullstack had eight passes and two failures. All five image builds/smokes passed, but HOST stopped at backup endpoint readback. Its inner and HOST cleanup completed. The older failed cleanup receipt remains historical evidence.

Current corrections address the missing test notification mode in the actual server-process fixture, current jobs/scan association, canonical static-suite counts/digest and target capabilities digest. The process still launches production `dist/server.js`; exact DB blocker, crash/lease recovery, restart and graceful drain assertions remain. Fixed allowlisted startup receipts bypass the disabled test logger. The private HOST fixture retains original suite identity/digest separately from public summaries. Backup endpoint diagnostics distinguish ownership, state, network and port failures using bounded fixed fields; actual failure cause remains for Linux readback.

The private browser draft exercise is a named step in the existing actual operational lifecycle, sharing its disposable actors. It accepts the exact dirty-editor replacement confirmation and labels file-selection stages. All persistence, import bytes, stale-write, recovery, requested-change and immutable-export assertions remain; production registration limits and replacement guards are unchanged. Local checks and exact results are recorded in the root handoff. Real PostgreSQL/process/MinIO, fullstack, final matrix and CodeQL remain maintained-controller proof. Renewed independent review and exact-candidate runtime acceptance are required.

The later exact ba69 run was cancelled on 1 October 2026 at `01:41:46Z` after the PG process test timed out and blocked completion. Collection verified 54 files; controller and inner cleanup completed. Both mocked browser lanes had 193 passes and one skip. PG comparison reached an obsolete review-status assertion and a following visibility cascade. Node22 fullstack stopped at an occupied pre-probed Mailpit port; Node24 main fullstack had seven passes and two failures, with actual 429 evidence at the composed artifact checkpoint and improvement submission. Connector/site, complete general checks, images/HOST and CodeQL have no acceptance from this cancelled run. Historical5128 receipts remain separate.

Independent ba69 review accepted the three prior P2 source corrections. The bounded followup corrects the immutable no-review assertion and guarantees visibility restoration, stages actual child/backend rollback before lease expiry, reads daemon-assigned loopback ports from exact owned containers, and configures API/MCP origins before authentication without restarting the bound web container. Operational and improvement journeys now each receive a fresh stack; their reports are separately required. Fixed CLI action, phase, workspace, code/status and local failure categories retain safe diagnostic evidence. Local endpoint/phase, CI wiring, diagnostic and same-slug CLI fixtures passed; they do not establish real PG/process, browser, HOST or full-matrix success. The existing mixed-version composed journey, private draft assertions, authorization guards and 600-request/60-second production limit remain intact. Final followup identity and check receipts are recorded in the root checkpoint/report; renewed independent review and actual runtime proof remain required.

External acceptance still includes configured provider/IdP behavior, live email, physical MFA/pilot evidence, signed-in host consent and recognition, broader adapters, arm64 runtime, selected publisher signing, public image/npm publication, tag/release and deployment. Durable server-side diagram/layout persistence and optional telemetry retain their original deferred/non-goal posture. Browser composed relocation remains a documented handoff limitation; no provider or consent commitment was invented to fill it.

Docker source decisions follow [selected-platform image inspection](https://docs.docker.com/reference/cli/docker/image/inspect/), [single-platform push](https://docs.docker.com/reference/cli/docker/image/push/), [bridge networking](https://docs.docker.com/engine/network/drivers/bridge/) and [host-address port publishing](https://docs.docker.com/engine/network/port-publishing/). Their application to this disposable gateway fixture is source reasoning; actual Linux behavior remains pending.


On 1 October 2026, independent dd806ac review required bounded process-fixture
failure cleanup and direct GitHub collection of operational/improvement evidence.
The followup adds fixture-only connection/query bounds, cancellation-aware waits
and bounded disposal of owned clients/transports/children even when gate unlock
fails. The actual child proof and 90-second limit remain. GitHub requires all four
sanitized reports; missing either new report fails its collector. Local cleanup
controls and collector/phase checks pass 6/6 each. Parent exact1839/dd806ac PG
results passed normal process recovery in both Node lanes but failed HIST
publication (312/314 each, child plus parent aggregate). The second private
manifest is now published under its reviewed visibility, with the prior public
policy restored in `finally`; all read denials and final revocation remain.
Local comparison/publication checks pass 6/6. Real corrected PG/runtime, renewed
independent review, fullstack/HOST and CodeQL acceptance remain open. All 426
criteria, 24 groups, fixed fingerprint and zero completed criteria are preserved.
No production-readiness or remote publication claim follows from these checks.
