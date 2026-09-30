# Roadmap execution ledger

Last updated: 2026-10-01 (Australia/Melbourne)
Status: implementation in progress. No roadmap completion or release acceptance claimed.

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

One Sol implementation worker owns shared source wiring at a time. A second child performs independent Astra review or isolated Sol HOST work.
Only one child owns shared integration writes; the parent controls local checks. Integration owns
source reconciliation, this ledger, exact-candidate verification and handoff.
Local dependency installation/build/test processes are serialized. The full
matrix runs on the maintained Windows/WSL controller behind its global lock.
No original MBP worktree or native thread is changed.

| Scope | Preserved source | Current continuation state |
| --- | --- | --- |
| Integration | `cd93bde57496` | 426 source criterion records and 24 backlog groups retained; source reconciliation and final matrix pending. |
| ID-GOV | `9106bc8cd953` | Integrated as `418e030`, hardened in `cf99c9b`; source review corrected, PostgreSQL execution pending. |
| TRUST-MCP | `4d3d183833f6`, recovery `e53508453908` | Integrated as `b10fcab` and `63b496b`, hardened in `cf99c9b`; source review corrected, canonical execution pending. |
| QUALITY | `561c045f6012` | Durable scans preserved; shared integration, PostgreSQL proof and version-aware evaluation extension pending. |
| AUTHOR-1 | `085acf87b006` | Private drafts/imports/comparison preserved; registration and full-stack acceptance pending. |
| ARCH-LIFE | `360243eeab86` | Persisted review plans preserved; authority review complete and bounded Codex composed-artifact contract selected; implementation pending. |
| DISC-SITE | `2453e69c3ba4` | Deterministic discovery and independent site preserved; wiring and measured/rendered proof pending. |
| HOST-1 | `3d01d673be27` | Isolated HOST source fixes and Linux rehearsal harness active; integration and actual install/upgrade/restore proof pending. |

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
linted; actual PostgreSQL execution is still pending. No deployed acceptance
is inferred from these reviews.

Migration reservations remain `0037_author_drafts.sql`,
`0038_device_login.sql`, `0039_package_scan_jobs.sql`,
`0040_architecture_plan_history.sql`. The artifact fix needed no new migration.
Allocate any additional composed-artifact/evaluation migration after checking
the combined sequence. Reuse existing persistence where it suffices; released migrations
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
| HIST-01 | Public/managed version comparison and history usability | AUTHOR + Integration | Inspect current comparison; implement missing bounded exact-version diff and authorized navigation/recovery. |
| QUALITY-01 | Background scans, leases/retries/crash recovery and immutable digest-bound findings | QUALITY | Existing `not-run` status retained until worker completion; approval fails closed; fence stale workers. |
| QUALITY-02 | Milestone 6 suites/runs, fail/warn/skipped/incompatible states, reviewer evidence, public-safe summaries and local CLI eval | QUALITY | Reuse improvement eval contracts; bind artifact/target/runner/review; paid execution separately gated. |
| TRUST-01 | Package policy fixtures, reviewer diff and lifecycle/migration paths | QUALITY + AUTHOR + TRUST | Retain controls; close evidenced gaps including hooks/binaries/generated files/injection and safe evidence. |
| TRUST-02 | Signed or direct authorized integrity-checked artifact delivery | TRUST | Current private API-proxied direct contract retained. Harden digest/size and current post-read auth. Presigned object URLs cannot promise immediate revocation. |
| MCP-01 | API per-tool/resource audit, privileged reads and stdio/HTTP compatibility | TRUST | Much delivered in beta.18. Distinguish delegated outcome from session intent; complete conformance/negative matrix. |
| MCP-02 | Native host discovery/first load and real ChatGPT/Claude OAuth acceptance | TRUST + Integration | Harness implementable; signed-in personal sessions and actual host behavior remain external acceptance. |
| ARCH-01 | Immutable nested topology, profiles/environments, digests, governance/sharing, editor/history/pattern migration and derived projections | ARCH | Foundations/explorer present. Reconcile stale branch language and prove exact-reference/denial behavior. |
| ARCH-02 | Persisted desired-versus-observed plans/history, fencing, approvals and recovery evidence | ARCH | Implementable review-only journal reuse; bind exact revision, observation, target generation/consent/capabilities and current policy/releases. |
| ARCH-03 | Full composed apply/verify/rollback across routers, leaves and targets | ARCH + Integration | Companion supports per-skill install/update/rollback, not router/profile orchestration. Keep deterministic design and remaining implementation explicit; pilot absence blocks live proof. |
| ARCH-04 | Two supported tool instances, placement/conflicts/enable/disable/relocate and broader adapters | ARCH | Two explicit isolated Codex workspaces can satisfy the two-instance criterion. Implement and verify their placement/isolation/lifecycle first; live consent remains external. Another provider contract is a separate downstream adapter choice. |
| ARCH-05 | Durable derived diagrams/versioned layout and optional usage telemetry | ARCH | Downstream choices explicit; exports remain accessible. Telemetry off/opt-in needs event/retention/export/delete policy. |
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

## External decisions and gates

1. Signed-in personal staging/ChatGPT/Claude consent, first load and revocation.
   No password, MFA code or private account data in chat or public records.
2. Physical issue #49 QR scans in the named authenticator apps.
3. Runtime IdP issuer, claim/linking/recovery policy and authorized config target.
4. Router/profile executor/artifact semantics are an implementation contract
   decision. Another provider is a separate adapter choice; two Codex instances
   need no second provider. Nominated target consent/recovery limits block live
   acceptance only. Per-skill fixtures do not complete the graph implementation.
5. REC provider, cost/request limits and data-egress after no-cost evidence.
6. Signing/distribution choice and precise merge/release/publish/deploy approval
   after review-ready candidates. Personal/work target must be explicit.
7. Downstream telemetry/layout choices and OSS/paid boundaries.
   Economics estimates provide no account consent or capacity proof.

Continue independent implementation while gates remain open. Do not imply
all-roadmap completion or silently remove the long-horizon architecture scope.
