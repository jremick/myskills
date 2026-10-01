# Roadmap execution ledger

Last updated: 2026-10-01 (Australia/Melbourne)
Status: final source corrections and criterion bindings prepared; bounded local proof is recorded separately. Final canonical verification and renewed independent review remain pending. No roadmap completion or release acceptance claimed.

This is the integration ledger for the authorized roadmap work. Completion
means review-ready implementations with exact revision evidence and explicit
residual decisions. The composed architecture lifecycle remains in scope:
discover, govern, version, share, compose, inspect and safely update skills.

## Authority and baseline

This is the authorized remote CLI continuation of the preserved roadmap work.
The source is `jremick/myskills`; all eight isolated recovery snapshots matched
the transfer manifest and started clean on 1 October 2026. Recovery commits
preserve work and are not feature acceptance. Original source work remains
preserved. The earlier native project threads are historical and are not active
execution owners.

The user authorized bounded implementation, independent review, commits,
pushes and draft PRs using GPT-6.1 Sol/xhigh for implementation and GPT-6
Astra/xhigh for hard review and coordination. Merge, release/tag creation,
package/image publication and Railway deployment retain explicit approval
gates. No paid model evaluations, provider/account changes, employer systems,
economics/paywalls or recurring automation are authorized.

Live readback at continuation start confirmed main at
`c74ecd33ce987d24ef5ddf40a0fef98f1a50fc9b`, no open PRs and open issue #49.
The existing public web version reports beta.16 at
`acfb7c8c7f8bc560f6fdba13cf0414033ab6d00e`; public API health/readiness passed.
This is existing production evidence, not deployment of the roadmap candidate.
The frozen beta.18 release candidate and its prior staging checks remain
separate from these changes.

## Owners and execution sequence

One Sol implementation worker owns shared source wiring at a time. A second child performs independent Astra review or bounded isolated Sol source work.
Only one child owns shared integration writes; the parent controls local checks. Integration owns
source reconciliation, this ledger, exact-candidate verification and handoff.
Local dependency installation/build/test processes are serialized. The full
matrix runs on the maintained Windows/WSL controller behind its global lock.
No original MBP worktree or native thread is changed.

| Scope | Preserved source | Current continuation state |
| --- | --- | --- |
| Integration | `cd93bde57496` | All 426 original clauses and 24 groups have separate current source/check/status/gap bindings. The fixed fingerprint and stale-binding gate are wired into structure. Final exact-candidate matrix and review remain pending. |
| ID-GOV | `9106bc8cd953` | Integrated as `418e030`, hardened in `cf99c9b`; independent source review complete and new atomicity/deadline PG cases passed in the failed first checkpoint. Final candidate proof pending. |
| TRUST-MCP | `4d3d183833f6`, recovery `e53508453908` | Integrated as `b10fcab` and `63b496b`, hardened in `cf99c9b`; independent source review complete and new coherent-authorization PG cases passed in the failed first checkpoint. Final candidate proof pending. |
| QUALITY | `561c045f6012` | Durable scans/evaluations and five authority/disclosure corrections passed exact5128 source review. Exact1839/dd806ac production-process recovery passed both Node lanes; PG aggregate remains failed at HIST publication. Followup failure-bound teardown and reviewed-visibility fixture corrections have local controls; their real PG proof and renewed review remain pending. |
| AUTHOR-1 | `085acf87b006` | Draft/import/history and CLI/MCP/browser comparisons are retained. Exact5128 real drafts failed at replacement confirmation and duplicate registration. The full browser exercise now shares operational actors and accepts the exact dialog; corrected PG/fullstack acceptance remains pending. |
| ARCH-LIFE | `360243eeab86` | Exact097 and exact4229 history retained. Exact5128 review required common OS-user enrollment authority and legacy nonempty-plan replay; current source includes both and canonical target fixture correction. Local process/replay checks pass; renewed review and actual PG/MinIO acceptance remain pending. |
| DISC-SITE | `2453e69c3ba4` | Discovery and site integrated through `8fafa42`; fixed synthetic corpus and local desktop/mobile/keyboard checks passed. PG/canonical/deployed proof pending. |
| HOST-1 | `3d01d673be27` | Exact5128 five image builds/smokes passed; HOST failed endpoint readback, then cleaned up. Current source preserves private suite restore identity/digest and adds fixed container-state/network/port diagnostics. Synthetic contracts pass; actual corrected Linux backup/restore and renewed review remain pending. |

Sequence: ID/TRUST source and review corrections; sequential QUALITY, AUTHOR,
ARCH, DISC and HOST integration; remaining no-cost evaluation and composed
architecture delivery; full exact-candidate verification and independent
review; draft PR and explicit release/deployment handoff. Source, fixture,
PostgreSQL, browser, real-host and deployed evidence remain distinct.

The first independent ID/TRUST source review found four material gaps: stale
PostgreSQL authority during final artifact authorization, time checks captured
before device-login lock waits, unbounded CLI response buffering, and device
secret forwarding through redirects. The independent remediation review accepted the source fixes. Three additional
PostgreSQL test-fixture/coherence defects were then corrected, typechecked and
linted; the new PostgreSQL atomicity/deadline and coherent artifact-authority cases then passed in both Node lanes of the failed first checkpoint. No deployed acceptance
is inferred from these reviews.

Migration reservations remain `0037_author_drafts.sql`,
`0038_device_login.sql`, `0039_package_scan_jobs.sql`,
`0040_architecture_plan_history.sql`, and composed delivery
`0041_composed_architecture_artifact.sql`. Isolated QUALITY reserves
`0042_package_evaluations.sql`. The earlier TRUST artifact fix needed no new
migration. Check the combined sequence before allocating another migration. Reuse existing persistence where it suffices; released migrations
remain append-only.

## Finite backlog

The companion [requirements inventory](ROADMAP_EXECUTION_REQUIREMENTS.json)
binds source criteria to document sections and lines. The source remains
[ROADMAP.md](ROADMAP.md), [business release goal](BUSINESS_SAFE_RELEASE_GOAL.md),
[control plane](SKILL_ARCHITECTURE_CONTROL_PLANE.md) and
[Workbench](ARCHITECTURE_WORKBENCH.md). Grouping below does not remove criteria.

| ID | Outcome | Owner | Current state and proof boundary |
| --- | --- | --- | --- |
| BASE-01 | Milestones 0–5 and 8 foundations: auth, registry, immutable review/lifecycle, install/update/rollback, public release gates | Integration | Delivered source foundations; fresh combined checks required. |
| ID-01 | Distributed auth limits, invitations/registration, last owner, role and MFA/account recovery, immediate revocation | ID-GOV | Postgres limiter and concurrent two-pool test already exist. Reconcile remaining governance and operational alert evidence. |
| ID-02 | CLI browser/device login | ID-GOV | Implementable durable hashed state, scope, consent/fresh MFA, slowdown, expiry, atomic denial/replay/revocation and credential storage. |
| ID-03 | Provider login/linking and external identity lifecycle | ID-GOV | Metadata/mappings exist; runtime issuer/claims/linking/recovery contract not selected. No-cost fixtures and exact decisions; no invented IdP configuration. |
| AUTHOR-01 | Multi-file drafts, reload/validation, save/history/diff/OCC, requested-change correction and submission | AUTHOR | Implementable; exact held bytes, current author policy/review and immutable releases. |
| AUTHOR-02 | Folder/ZIP and public commit-pinned GitHub previews with byte/provenance fidelity | AUTHOR | Retain delivered public GitHub imports. Complete folder/ZIP draft paths. Private GitHub, binary and AI choices remain explicit. |
| HIST-01 | Public/managed version comparison and history usability | AUTHOR + Integration | Dedicated API-authorized exact published-release CLI/MCP comparison now exists alongside browser comparison. Full-content status, byte/digest identities and bounded previews have local contracts; canonical runtime parity remains pending. |
| QUALITY-01 | Background scans, leases/retries/crash recovery and immutable digest-bound findings | QUALITY | Existing `not-run` status retained until worker completion; approval fails closed; fence stale workers. |
| QUALITY-02 | Milestone 6 suites/runs, fail/warn/skipped/incompatible states, reviewer evidence, public-safe summaries and local CLI eval | QUALITY | Immutable exact artifact/suite/runner/review evidence and local static evaluation exist. Details remain private by canonical scope; explicitly authorized public summaries omit private identities. Canonical persistence/expiry proof is pending; provider behavior stays skipped when unconfigured. |
| TRUST-01 | Package policy fixtures, reviewer diff and lifecycle/migration paths | QUALITY + AUTHOR + TRUST | Retain controls; close evidenced gaps including hooks/binaries/generated files/injection and safe evidence. |
| TRUST-02 | Signed or direct authorized integrity-checked artifact delivery | TRUST | Current private API-proxied direct contract retained. Harden digest/size and current post-read auth. Presigned object URLs cannot promise immediate revocation. |
| MCP-01 | API per-tool/resource audit, privileged reads and stdio/HTTP compatibility | TRUST | Much delivered in beta.18. Distinguish delegated outcome from session intent; complete conformance/negative matrix. |
| MCP-02 | Native host discovery/first load and real ChatGPT/Claude OAuth acceptance | TRUST + Integration | Harness implementable; signed-in personal sessions and actual host behavior remain external acceptance. |
| ARCH-01 | Immutable nested topology, profiles/environments, digests, governance/sharing, editor/history/pattern migration and derived projections | ARCH | Foundations/explorer present. Reconcile stale branch language and prove exact-reference/denial behavior. |
| ARCH-02 | Persisted desired-versus-observed plans/history, fencing, approvals and recovery evidence | ARCH | Implementable review-only journal reuse; bind exact revision, observation, target generation/consent/capabilities and current policy/releases. |
| ARCH-03 | Full composed apply/verify/rollback across routers, leaves and targets | ARCH + Integration | `48839644` implements bounded whole-artifact orchestration with immutable API intent, separate execution approval, shared lease and local journal. Two enrolled workspace fixtures and interrupted transitions pass; independent review, PG/MinIO and live consent/recognition remain distinct pending proof. |
| ARCH-04 | Two supported tool instances, placement/conflicts/enable/disable/relocate and broader adapters | ARCH | Two explicit isolated Codex workspaces can satisfy the two-instance criterion. Implement and verify their placement/isolation/lifecycle first; live consent remains external. Another provider contract is a separate downstream adapter choice. |
| ARCH-05 | Durable derived diagrams/versioned layout and optional usage telemetry | ARCH | Derived accessible diagrams/exports exist. Durable server-side layout is an explicit original deferred non-goal; optional telemetry remains future opt-in scope without a selected event/retention/export/delete contract. |
| HOST-01 | Versioned images/Compose, fresh usable deployment, setup and diagnostics | HOST | Implementable candidate bundle/helper; fresh Linux/amd64 gate and explicit arm64 build/runtime evidence or reviewed support limit. Record emulation separately. Exact source/image identity and public availability required before support claims; publishing gated. |
| HOST-02 | Full app backup/restore, upgrade/rollback, monitoring/incident response and recovery UX | HOST | Rehearse scripts/runbooks with data-loss/lock limits and measured times. Dedicated owner/admin browser guidance and sanitized receipt inspection are assigned; UI fixtures do not prove restored login/package bytes. No remote host executor is implied. |
| RELEASE-01 | Reproducible provenance/SBOM/digests, protected tags, signatures and release policy | TRUST + HOST + Integration | Deterministic preparation; signing/distribution choices and publication/deploy gates explicit. |
| DISC-01 | Authorized task recommendations and useful no-cost search/no-match evidence | DISC | Deterministic baseline; exact approved results, method/fallback/uncertainty and no activation. Model benefit needs provider/budget/egress and independent evidence. |
| SITE-01 | Independent homepage/docs/gallery/download/security and workflow demos | DISC | Implementable canonical links/public-safe examples/beta claims; newcomer/mobile/keyboard/rendered proof; deployment gated. |
| ACCEPT-01 | Physical MFA QR, deployed responsive/accessibility and provider acceptance | Integration + human | Issue #49 and signed-in sessions pending. Mocked/local/staging/human results remain distinct. |

## Integration and verification records

Each owner supplies source/head/tree/base, changed contracts, PR, independent
review, acceptance checks, exact run IDs, evidence hashes and remaining limits.
Candidate fields remain pending until read back. Supported runtime is Node22/24
and npm11.12.1. The maintained controller schedules the Windows Linux worker
behind its global heavy lock. Four lanes form one complete seven-job gate;
there is no laptop Docker fallback or concurrent unrelated stack work.

Combine reviewed commits in dependency order, regenerate capability parity,
run affected workflows and the full immutable-candidate matrix, then refresh
security/threat-model and operations evidence. Updated source invalidates old
revision checks. Source, fixture, real host, staging, release/registry and
production evidence are separate.

Baseline controller readback: `myskills-verify-c74ecd33ce-1` succeeded with all
seven jobs passed, cleanup complete and `reportable: true`. Its source commit
matches `c74ecd33` and tree `93afae984b5eafd485ed276cc76d5aab7df65cee`.
Reported export SHA-256 is
`8d34566b3f466cae2337b2b9b87ed1e76cf4e35f91fd49ce9e3c33bc254a2f43`.
This was a controller status readback, not an independent export-hash audit and
not verification of new roadmap changes. Windows doctor also passed required
Linux/amd64, Docker/Compose/Buildx, agent and Node22/24 npm11.12.1 checks.

Test-first TRUST-MCP checks reproduced baseline artifact retrieval after
in-flight token/account/team/lifecycle revocation and altered bytes, plus
unbounded or invalid UTF-8 object responses. The fixes are committed in `cf99c9b` and independently source-reviewed.
Supported local checks passed: 38 focused ID/TRUST checks, 46 CLI/install/device/
stream checks, and 138 existing CLI/MCP contract checks. These suites overlap.
Source builds, web typecheck, lint, privacy, secret scan and parity also passed.
An additional API regression batch passed 52 of 53; the missing denied-platform
audit event was fixed and its focused regression passed. The whole 53-case batch
was not repeated. Canonical PostgreSQL, MinIO and browser execution remains
pending. These are controlled source/runtime fixture findings, not deployed proof.


### First ID/TRUST canonical checkpoint

`myskills-roadmap-idtrust-20261001` tested source
`35ae5060f69267e5249645566307b7c27d4ae24c`, tree
`05caef628f834d64b5b83bc7a6a90d60a26a6559`, through all seven jobs.
It **failed**. Both browser jobs and Railway images passed. Both PostgreSQL
jobs and both check jobs failed. Cleanup completed with no leftovers. The
controller verified collection of 92 files; export SHA-256:
`5fdfded7e19308d6490db0ca438225a5f3fffc5070b0ac0e40b0c265d7787447`.

The new PostgreSQL device atomicity/deadline and artifact authorization snapshot
cases passed on Node22 and Node24. The older device journey needed a shared
simulated clock with the store. Altered approved payloads failed earlier at the
integrity check, bypassing the expected publication error contract. Release
fixtures omitted the new provenance script and its lockfile dependency.
The two PostgreSQL corrections are in wave2 and the release-fixture correction is in HOST. Their combined canonical rerun remains necessary.
Browser fixture/full-stack success does not establish live host or deployment
acceptance. Subsequent roadmap source is outside this checkpoint.

### Preserved roadmap integration checkpoint

The QUALITY, AUTHOR, architecture review-plan and discovery/site recovery
sources are integrated through `8fafa42e24169629f3666440c9c90138d4354079`.
Corrective commits separate API authority/durable evidence (`9a6d203`), browser
state (`acf42d9`), product-thesis copy (`5082efe`) and shared API/CLI/MCP/web
registration (`8fafa42`). The two ID/TRUST PostgreSQL regression fixes are
included; their canonical rerun remains pending.

Supported local evidence passed: 21 focused API/CLI/MCP cases, 143 web
DOM/API tests, 140 core tests, 25 affected application browser cases and 12
independent-site desktop/mobile/keyboard cases. These counts are not additive
coverage measures. Combined source build, web and prepared PostgreSQL test
source typechecks, lint and generated parity also passed. Static parity reports
134 groups, 236 API operations, 54 CLI commands, 210 MCP tools and five native
handlers. Actual new PostgreSQL queue/draft/discovery/review-plan concurrency
and restart execution still needs canonical verification. Independent source
review of this exact checkpoint is pending.

The parent inspected updated desktop/mobile site screenshots. The site now
leads with composed skill sets, versioned architectures, profiles/environments
and desired-versus-observed review. The fixed discovery corpus compares
lexical-v1 with ordinary substring search and includes no-match and local
latency observations; it establishes neither model benefit nor activation.

The composed execution decision is `codex-workspace-architecture/v1`: exact
API-owned intent, separate execution approval, a shared target lease and a
bounded local whole-artifact journal. Full graph/router/profile apply, verify
and rollback implementation remains in progress. Review-only plans never
become execution authority.

### HOST review remediation checkpoint

Initial HOST recovery, version preparation and hardening are integrated as
`6c09e24`, `6b3a352` and `84e6cae`. The independent site version is aligned to
beta.19 in `2b27113`. HOST remediation is separately committed at
`6a45918e28043bd5436cd15e9145acd68897019d` and integrated as `d6c4694`. Its
independent Astra remediation review required two further fixes: retry startup
must persist both durable fences before SQL, and expected failing helpers need
verifiable terminal cleanup. These fixes passed local contract regressions;
independent follow-up review and real Linux execution remain pending.

The fixes cover durable migration barriers before SQL, protected env parsing,
bootstrap validation on the public shell path and unresolved interrupted
Compose operations. Local evidence passed 82 focused cases, 35 controller
fixtures, two latest interruption cases, lint, shell syntax and static parity.
These overlap and use stubs; they do not prove Linux installation or restore.
The prepared canonical rehearsal checks actual Compose interpretation,
encrypted TOTP access, revoked-session denial and authenticated non-owner
private-artifact denial after restore and upgrade. Runtime execution remains
pending, including real database/object recovery and exact resource cleanup.

The baseline transition uses exact c74ecd33 beta.18 application source and a
disclosed candidate setup/bootstrap bridge because that baseline has no
historical operator package. It cannot prove a historical package-to-package
upgrade, arm64 runtime or the current production beta.16 migration path.
No public image, release or deployment is inferred from this preparation.

### Independent wave2 findings and active corrections

Independent Astra reviewed exact `8fafa42`, tree
`64c56711ecbfa86ad0c4037458e14f277759514f`, against `35ae506`. Four material
findings remain subject to corrected-source acceptance: current credentials
must survive draft/plan lock waits; external team members need their parent
organization policy retained during private forks; approval/publication must
consume the successful scan's exact artifact digest; and draft state must clear
when the API connection changes for the same actor.

Architecture owns plan authority and HOST follow-ups. The separate QUALITY
branch committed draft/scan/browser corrections in
`efadbc1e18439250361ea9f07162bf7d30dde295`; this source is not yet integrated or
tested. Its no-cost evaluation extension reuses improvement suite revisions,
labels local results as self-reported and leaves provider behavior unconfigured.
Actual source and runtime acceptance remain pending.

Architecture working-tree checks passed nine focused cases, including bounded
journal replay and a counted-download regression, and 85 combined HOST fixture
cases. API/MCP builds and web typecheck passed before subsequent source edits.
The expanded OAuth MCP transport case and four targeted release-check cases
also passed. Earlier fixture runs retained a loopback sandbox failure, an OAuth
fixture configuration failure, and two 34/35 controller failures. The final
release-check correction keeps early provenance rejection and distinguishes
never-created resources from removed resources. None of these counts is a
whole-candidate or deployed acceptance claim.

New PostgreSQL and real MinIO composed-workspace tests are prepared for the
maintained canonical jobs. Missing local browser executables prevented the
first ten-case browser run from launching; its configured-browser rerun is
pending. The source inventory remains 426 original contracts and 24 groups.
The final candidate still needs all seven canonical jobs, CodeQL, independent
review of the final corrections and explicit external release/deployment gates.

## External decisions and gates

1. Signed-in personal staging/ChatGPT/Claude consent, first load and revocation.
   No password, MFA code or private account data in chat or public records.
2. Physical issue #49 QR scans in the named authenticator apps.
3. Runtime IdP issuer, claim/linking/recovery policy and authorized config target.
4. The composed executor contract has been selected above; source implementation
   and exact verification remain necessary. Another provider is a separate
   adapter choice; two Codex instances need no second provider. Nominated target
   consent/recovery limits block live acceptance only. Per-skill fixtures do not
   complete the graph implementation.
5. REC provider, cost/request limits and data-egress after no-cost evidence.
6. Signing/distribution choice and precise merge/release/publish/deploy approval
   after review-ready candidates. Personal/work target must be explicit.
7. Downstream telemetry/layout choices and OSS/paid boundaries.
   Economics estimates provide no account consent or capacity proof.

Continue independent implementation while gates remain open. Do not imply
all-roadmap completion or silently remove the long-horizon architecture scope.

### Composed architecture and HOST checkpoint

Source `48839644f135ead76d97aeca1b1cb1be2aa09a26`, tree
`d9af5df32eaea024dc438d33ed375f241f36c9a0`, is committed cleanly. It adds
`codex-workspace-architecture/v1`: immutable exact graph/profile/environment
intent, separate execution approval, shared target leases, bounded local
staging and a whole-artifact journal. Review-only plans stay non-executable.
The browser and MCP prepare or inspect intent and hand execution to the
enrolled companion. OAuth cannot authorize host execution.

Local checks passed: 19 focused API/core/CLI cases including two explicitly
enrolled workspaces and 39 interruption scenarios; the final API rerun 4/4;
expanded MCP token/OAuth fixture 1/1; corrected handoff browser cases 3/3;
HOST narrow fixtures 85/85; controller fixtures 36/36. Counts overlap and do
not measure requirement completion. The parent inspected desktop/mobile
handoff and recovery screenshots. Builds, PostgreSQL test-source typecheck,
scoped lint, generated parity, beta.19 package smoke, structure, privacy and
secret checks passed. A sandbox npm-cache failure passed on a bounded
task-local retry; shared cache permissions and configuration were unchanged.

The actual PostgreSQL, MinIO and Linux install/upgrade/restore journeys are
prepared and required by canonical gates. They are not established by those
local results. The maintained Windows run
`myskills-roadmap-composed-20261001` accepted this exact source at
`2026-09-30T21:12:31.972749Z`. At this historical checkpoint it was running. Its source manifest digest is
`8f70403ce77cc7455668077117dea32904df97f5c2e9affd1a33dd5bdae58c64`.
At that observation, results and collection were pending. This checkpoint excludes later
QUALITY evaluation/remediation source and cannot gate the final roadmap.

At that historical observation, independent Astra/xhigh review was running on an isolated clean clone of
`48839644`, including the two HOST remediation follow-ups. The completed
Sol/xhigh architecture worker has exited. After live idle-process verification,
QUALITY received this exact dependency and the sole local heavy-process slot
for isolated integration and checks. No push, merge, release, publication or
deployment has occurred. All 426 original criterion identities and source
descriptors, and all 24 groups, remain preserved; final evidence reconciliation
is still required.

The composed run subsequently finished at `2026-09-30T21:25:40.751562Z` with all seven jobs failed. Collection verified 46 files with export SHA-256 `03536a6e863ce9cdac42cb19d64f2865d146f4876c1de2f95c9a3345acf18d0f`. Application cleanup failed at the owned HOST ledger; the original `remove-failed/creationUnconfirmed` receipt and run reservation remain historical evidence. A later restricted supervisor readback found the exact container absent at `2026-09-30T22:49:59Z`; this does not rewrite creation uncertainty or the failed receipt. Downstream fullstack/site and complete restore were not reached.

The independent review completed with six required corrections, followed by exact097 remediation review with seven further findings. Those assigned final source corrections are documented below and require renewed review. The exact `097cd50db075e691fb8d535601b4560ba0cdbfe2` diagnostic finished at `2026-09-30T22:46:58.256021Z`, all seven jobs failed, and collection verified 46 files with export SHA-256 `4a58b0c52eed2ff6caf14dfea6a7123e4b03ed088445fe545c17bec80faf4a03`. That run's current cleanup completed; it is separate from the earlier retained failed history. Neither run includes the final corrections or supplies final acceptance.

## Final candidate reconciliation

The final continuation composes the frozen QUALITY base with exact097 dependency and adds
its assigned remediation, HIST CLI/MCP comparison and pre-approval reviewer
comparison. [Current candidate delivery](ROADMAP_CANDIDATE_DELIVERY.md) records
source behavior, migration compatibility and trust boundaries. It supersedes
stale present-tense delivery claims while dated beta.18 and prior evidence
remain historical.

All 426 preserved clauses have separate current bindings in
[the criterion map](roadmap-criterion-bindings.json). The deterministic structure
gate checks the captured contract, 24 groups and current source anchors/hashes.
A binding or local fixture receipt is not completed acceptance. The root final
report carries the committed identity and specific command results; canonical
SQL, browser, Linux/HOST and CodeQL receipts remain parent-owned.

### Collected exact5128 and current remediation

`myskills-roadmap-reconciled-20261001` finished at `2026-10-01T00:45:25Z`.
Collection verified 60 files with export SHA-256
`5cd94926f5ab9b00dec64500cebc4e3c98035c7d9c0ad3fd09ec400edd752408`.
Both general checks passed; PostgreSQL had 306 passes and six failures per
Node22/24 lane; mocked browsers had 193 passes and one skip; fullstack had eight
passes and two failures. All five image builds/smokes passed; HOST endpoint
readback failed before install/upgrade/restore. Current inner/HOST cleanup
completed. Earlier uncertain creation and failed cleanup history remain intact.

Immutable5128 review completed with three P2 corrections: private suite restore
binding, XDG-independent enrollment authority and pre-correction nonempty-plan
replay. These and the collected runtime fixture failures have current source
corrections in the owned final branch. HOST endpoint cause is still unconfirmed;
safe bounded diagnostics distinguish actual state/ownership/port failures on
the next Linux run. No local fixture substitutes for final process, PG, browser
or coordinated restore proof. Exact candidate identity/check receipts and
renewed immutable review are recorded in the parent remediation handoff.

### Collected ba69 and bounded followup — 1 October 2026

`myskills-roadmap-corrected-20261001` ran exact
`ba69ffe1931cd9d4dc87e00c6a79acdef9b3362a`, tree
`d0bc065a3db13f85a1bfde907b7881001b566e1f`. The parent cancelled it at
`2026-10-01T01:41:46Z` after both browser lanes finished and a PostgreSQL
process timeout prevented completion. Collection verified 54 files with export
SHA-256 `bead48816dbe05a843a72ec7ef19dfd33e1aa6d1e573e2a74c332aa14b00764f`.
Controller and inner cleanup completed. Older failed receipts remain intact.

The reached PG comparison asserted obsolete `pending` rather than canonical
`unreviewed`; its failed private-visibility test left the following anonymous
HIST positive denied. Source inspection identifies the cascade; an actual rerun
must confirm it. The actual production process fixture timed out at 90 seconds;
its internal stage was unknown. Both mocked browser lanes passed 193 tests with
one skip. Node22 fullstack setup failed when the pre-probed Mailpit port was
occupied. Node24 main fullstack had seven passes and two failures: the composed
CLI exited before the draft callback, and improvement submission returned 429.
The retained proxy log also records 429 at the artifact checkpoint. Connector,
site, complete general checks, images/HOST and CodeQL did not supply acceptance
in this cancelled run. No new HOST failure cause is established.

Independent ba69 review accepted the prior three P2 source corrections: private
HOST evaluation restore binding, OS-user enrollment authority across XDG roots,
and nonempty legacy-plan replay under current authorization. Its remaining
review-status/cleanup fixture finding is addressed in the followup. Source
acceptance of the complete new delta and runtime acceptance remain pending.

The owned followup preserves the review state, restores scoped visibility in
`finally`, and adds exact child/backend stages with gate release before lease
expiry. Fullstack automatic ports now come from owned running-container
readback; API/MCP origins are configured before authentication, and nginx reload
keeps the bound web container. Operational and improvement journeys each use a
fresh stack under unchanged production limits. CLI failures expose fixed safe
action/phase/workspace/code/status categories. Local endpoint/phase fixtures
passed 11/11, focused permitted CI wiring passed 3/3, diagnostic controls passed
1/1, and the same-slug/two-profile CLI variant passed 1/1. These are bounded
local receipts, not production-process, PG, real browser or restore proof. Exact
followup SHA/tree and final binding/parity/check receipts belong in the root
checkpoint and report. All 426 original criteria and 24 groups remain preserved.


### Followup review corrections — 1 October 2026

Independent review of exact `dd806ac932eeb47d74a94dbcb8c461832700d92c`
withheld source acceptance for two P2 gaps. The process fixture now bounds its
own connection, query, polling, child-exit and teardown operations. Cancellation
starts owned cleanup; unlock rejection or timeout cannot skip transport/client
and child disposal. Production pool defaults, the 90-second outer limit, actual
SIGKILL, exact backend disappearance/rollback before lease expiry, distinct
replacement, held SIGTERM drain and immutable final history remain. Six local
wire-peer/real-child controls pass; these are failure-disposal proof, not PG
recovery acceptance. GitHub CI now requires all four sanitized fullstack reports
with existing always/non-skipped conditions and distinct upload subdirectories.
Collector/phase checks pass 6/6, including each new report missing independently.

Parent `CI_INTERIM.md` reports exact synthetic merge
`1839c5c4b78ed685d26fa77e3690be7f5da3d959`, tree identical to dd806ac:
production-process recovery passed both Node lanes (~2.5 seconds), but PG finished
312/314 each. The failures are the HIST child and its parent aggregate. The newly
reached publication mismatch is independent of the earlier visibility cascade:
both immutable manifests are private, while the preceding summary fixture made
the skill public. The second real publication now uses its reviewed visibility
and restores the prior public read policy in `finally`. Every HIST denial, pin,
identity and final-revocation assertion remains. Local comparison/publication
checks pass 6/6; this corrected PG journey is unrun. Mocked browser suites passed
193 with one skip each on the old candidate; fullstack/general/HOST/CodeQL and
full collected results remain open in the supplied handoff. No current-delta
runtime pass, renewed review, criterion completion or production readiness is
claimed. Parent owns remote actions and Windows evidence. Exact local commit,
receipts and freeze state are in `FOLLOWUP_REVIEW_FIX_CHECKPOINT.json` and
`followup-review-remediation.md` in the root reports directory.
