# Roadmap execution ledger

Last updated: 2026-10-01 (Australia/Melbourne)
Status: implementation in progress. No roadmap completion or release acceptance claimed.

This is the integration ledger for the authorized roadmap work. Completion
means review-ready implementations with exact revision evidence and explicit
residual decisions. The composed architecture lifecycle remains in scope:
discover, govern, version, share, compose, inspect and safely update skills.

## Authority and baseline

Jarel authorized implementation through new MySkills project chats using native
GPT-6.1 Sol at xhigh, including bounded delegates, review branches, commits,
pushes and draft PRs. Merge, publication, deployment, account changes and live
target actions retain their explicit gates. No paid provider calls, employer
data, billing/paywalls, new credential paths or unrequested automations.

The saved MySkills App project and `jremick/myskills` origin were checked.
GitHub main was `c74ecd33ce987d24ef5ddf40a0fef98f1a50fc9b`, including explorer
PR #126; no PRs were open. Issue #49 remains open. Beta.18 final staging was
verified in the prior delivery closeout at source
`1439b5a83f4d07d3316e8134127df3fbe4c4a1c6`, with reported 1,372 repository
tests, 253 PostgreSQL tests and 171 browser journeys. These are prior-candidate
results. They do not verify this integration branch or real ChatGPT/Claude
acceptance. The frozen beta.18 candidate stays separate from these changes.

The primary checkout's untracked `work/` is preserved. Native handoffs retained
the managed checkout paths and restored existing work from checked backups.
The integration checkout also has an untracked handoff `work/` copy, which must
not be committed. The writable-cwd probe passed without escalation.

## Owners and work waves

Old chat IDs were superseded by the native handoffs. Use these continuations.

| Package | Current chat ID | Ownership | Branch and acceptance state |
| --- | --- | --- | --- |
| Integration | `01a0f2e1-4c05-7d92-81fd-55bba089cf49` | Ledger, requirements coverage, roadmap/business/architecture reconciliation, integration, review and verification queue | `codex/complete-myskills-roadmap`; base `c74ecd33`; candidate pending |
| AUTHOR-1 | `01a0f2e2-1927-7dc0-ad5a-c53aa7cad841` | Private drafts/editor/history/import preview and exact submission handoff | Candidate/PR/checks pending |
| HOST-1 | `01a0f2e2-8051-7a73-a372-83fe94d10c0c` | Images/Compose bundle, protected setup/status/diagnostics, upgrade/recovery and CI tooling | `codex/build-myskills-selfhosting-delivery`; candidate pending |
| ID-GOV | `01a0f2e2-a47f-7d03-a31e-e8c585fa012e` | Device browser login, governance/recovery and provider trust decisions | `codex/build-myskills-identity-and-governance`; candidate pending |
| QUALITY | `01a0f2e2-ff67-7fd0-afc4-abf289144795` | Durable scans, version-aware eval/reviewer/release evidence | Branch readback pending; candidate pending |
| ARCH-LIFE | `01a0f2e3-2992-7d11-ab7b-54fa386405a7` | Exact-revision plans/history, fencing and composed lifecycle | Review-only plan slice underway; full execution residual explicit |
| TRUST-MCP | `01a0f2e3-5155-7cc1-9acf-a2ebe26df5b1` | Artifact integrity/current authorization, MCP conformance/audit and provenance | Direct API delivery hardening underway; candidate pending |
| DISC-SITE | `01a0f2e3-7d80-7ea0-b505-e32de6a60382` | Deterministic task discovery and independent product/docs site | Candidate pending; no model calls or site publication |

Wave 1 develops owned modules, failure scenarios and independent checks.
Shared wiring slots follow ready candidates, with one active owner. ID is
currently active; TRUST → QUALITY → ARCH → AUTHOR → DISC follow. HOST owns
the separate release/CI tooling slot. Wave 2 completes eval/review/client/site
workflows and operations rehearsals. Wave 3 combines reviewed commits and runs
the exact revision matrix, independent review and release readiness checks.
Launching a chat or passing one slice does not complete its package.

Migration reservations: `0037_author_drafts.sql`, `0038_device_login.sql`,
`0039_package_scan_jobs.sql`, `0040_architecture_plan_history.sql` if needed,
and `0041_artifact_delivery.sql` if needed. Use existing persistence when it
suffices. Released migrations remain append-only.

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
unbounded or invalid UTF-8 object responses. The owned fix and independent
review are underway. These are controlled source/runtime fixture findings;
no deployed exploit or completed remediation is claimed.

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
