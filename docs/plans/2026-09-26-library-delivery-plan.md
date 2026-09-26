# Libraries: delivery plan and contract outline

Status: phases 1A–1C were approved on 2026-09-26 and are being implemented for beta.8. The design sequence below includes later phases. Current behavior is defined in the [API contract](2026-09-26-library-api-contract.md), and completed checks and open decisions are recorded in the [build evidence](2026-09-26-library-build-evidence.md). No publication or production deployment is claimed.

Date: 2026-09-26. Parent specification: [Libraries](2026-09-26-library-feature-spec.md). Baseline: GitHub `main`, `7a0fc44e6a1cabaabfdcf494c3cc96db4cf7d3cc`.

## 1. First implementation slice

**Slice 1A: personal library with a public GitHub source, immutable import preview and manual adoption.**

Outcome: a user can save the example repo, select a supported complete skill, preview and submit pinned bytes, retain provenance, adopt its approved release, and use existing manual install/update. Unsupported whole plugins remain useful saved references.

Affected scope: additive source/library/provenance contracts, API persistence and authorization, bounded GitHub read adapter, existing package intake integration, minimal Libraries UI, corresponding CLI commands and tests. Include adoption constraints in existing Updates evaluation and opt-in library references in connected and standalone installation records. Reuse the existing registry, author/reviewer boundary, artifact storage, installer and Updates UI. No scheduled checks, private credentials, new dependency or live operation is needed to prove this first loop.

Material assumptions: public GitHub first; personal imports; existing supported text package limits; existing release review permissions with an available instance reviewer; Codex as the first managed target; source names and registry slugs remain separate. Required files that cannot be packaged safely produce an explicit blocked preview. First-release imports receive an opaque lineage suffix to avoid cross-scope name collisions; the approved runtime-name normalization uses that slug while retaining the original file and both digests.

Validation: deterministic public-source fixtures, held-byte verification, cross-user authorization cases, registry-review integration, source provenance export, existing manual update regression and a real-source discovery/import rehearsal in a disposable environment. Stop if the chosen skill needs an unsupported package format, unknown license handling, silent file rewriting or a new authorization boundary.

Non-goals for this slice: team-owned imports, organization credentials, scheduling, email, auto-update, custom daemons, native plugin control, cross-skill atomic updates and provider-host activation claims. Keep those in later slices, not hidden prerequisites for 1A.

## 2. Phases and release gates

| Phase | Deliverable | Requirement coverage | Gate before next phase |
|---|---|---|---|
| 1A — collect and import | Personal libraries, source references, discovery, pinned preview, mapping, provenance, manual review/adoption, API/CLI/web parity | LIB-01–06, 09–10, 16–17 | Complete manual source-to-reviewed-release journey with preserved originals, explicit hashed name normalization and denied unauthorized access |
| 1B — follow changes | Durable source checks; daily/weekly schedule; last-success/next-due health; relevant file diffs; new/removed/renamed skills; in-app subscription inbox | LIB-07–08, 11, 18 | Repeated checks, retries, rate limits and source changes produce complete, deduplicated candidates and honest stale status |
| 1C — team curation | Team libraries of authorized personal/existing releases; effective-grant preview; curator notes; team opt-in subscribers | LIB-01, 10–11, 16–17 | Member removal and inaccessible entries cannot leak content or metadata; personal ownership dependencies visible |
| 2A — durable shared ownership | Team/company-owned sources and imported lineages; organization ceilings; owner transfer/offboarding | LIB-01, 10, 15–16 | Imported content survives curator departure under explicitly authorized scope ownership; grants remain constrained |
| 2B — private GitHub and delivery | Repository-selected GitHub App, explicit distribution grants, revocation, scoped caches, webhooks/reconciliation; optional email digest | LIB-07, 10–11, 15, 18 | App suspension, source access loss, private-to-shared actions and delayed sends pass cross-tenant tests |
| 3A — controlled target automation | Explicit automation grants; queue approved adoptions; stage/apply modes where supported; windows; drift, authority rechecks and recovery | LIB-12–14 plus 09–11 | Physical target pilot proves consent, no lost edits, lease recovery, rollback and accurate reload status |
| 3B — rollout controls | Pilot groups, bounded rollout, hold/pause, coverage with freshness; coupled-set handling only with a verified adapter | LIB-12–14, 18 | Failure pauses new scheduling; partial success and rollback limits remain explicit |
| Later optional | Unattended upstream adoption, multi-host adapters, GitLab/local source tracking, three-way merge, AI summaries | Requires additional scoped decisions | Evidence from the manual and controlled automation phases justifies each extension |

The first product release can include 1A–1C. Private GitHub in that release would move 2A–2B forward and increase its authentication, ownership and operational scope. Do not silently absorb that change. Company ownership does not imply mandatory rollout to personal devices.

## 3. Proposed data contracts

These are logical boundaries, not a requirement for one table per row. Follow the existing Postgres/store patterns and combine records when their transactional lifecycle is identical.

| Record | Essential fields/invariant |
|---|---|
| `Library` | ID, owner type/ID, name, description, status, revision, createdBy, timestamps; owner scope validated |
| `LibraryGrant` | Library, audience, permissions; never replaces skill/source entitlement |
| `LibraryEntry` | Library, stable entry ID, kind, upstream track or registry skill, adopted release pointer, expected revision; duplicate choice explicit |
| `UpstreamSource` | Provider, stable repository ID, canonical/display URLs, owner scope, visibility classification, connection reference/generation, health |
| `SourceTrack` | Source, selected paths, ref kind/value/prefix, selection digest, importer version, schedule, next due, last attempt/success |
| `SourceSnapshot` | Source/track, exact commit/tree, ref-resolution evidence, inventory digest, completeness, per-selected-file paths/sizes/hashes, restricted object keys |
| `ImportCandidate` | Prior adoption, source snapshot, package bytes/digest, diff summary, manifest mapping, classification, findings, disposition, expiry, revision |
| `ReleaseProvenance` | Existing release identity, origin snapshot, original/output digests, upstream label, transforms, notices, importedBy; immutable |
| `LibraryAdoption` | Entry, exact approved release and provenance IDs, actor, reason, predecessor and decision revision; append-only |
| `SourceJob` | Scope, track, due time, attempt count, lease/fence, idempotency identity and bounded status; no secrets |
| `LibrarySubscription` | Principal, library/entry/event selection, channels/digest/quiet hours, revision; membership alone is not consent |
| `LibraryEvent` / delivery intent | Semantic event ID, scope, restricted references, recipient/channel key, status and attempts; render content after authorization |
| `LibraryTargetBinding` | Entry, target ID/generation or opaque standalone installation reference, installed identity, selected adoption/channel, installation owner; one effective choice per install key; local paths stay local |
| `AutomationGrant` | Authority principal/scope, binding, expiry, policy constraints, modes, generation/revocation; distinct from maintenance windows |

Use transactionally unique keys for `(scope, provider, repository ID, connection identity)`; `(track, exact commit, selection digest, importer version)`; candidate-to-submission mapping; and `(recipient, semantic event, channel)`. Public unauthenticated sources use a fixed connection identity; credential rotation changes the connection generation, not the stable connection ID. Separate connections for the same repository must not collapse authorization. References use immutable internal IDs, not only slugs or URLs.

Candidate identity includes lineage, source snapshot and import-profile digest. Multiple skills from one source snapshot are grouped for display only. Candidate acceptance uses both a current lineage-head precondition and explicit source ordering; it never numbers old snapshots as newer updates merely because approval arrived late. Missing change metadata is rejected at the import boundary; unclassified mappings are explicitly conservative.

Source snapshots can store only inventory until a user requests an import. Preparing an import stores held, bounded bytes. Keep raw source digest and packaged artifact digest distinct. No generic mutable cache can become authoritative provenance.

### Existing ownership is a real migration boundary

Current submissions have `ownerUserId`; team membership and grants do not create team-owned skills. Phase 1A keeps that contract. Phase 1C makes personal ownership dependencies visible and does not promise automatic ownership transfer.

Team libraries initially reference releases already shared with the team. Only the personal lineage owner can create new imported revisions under that ownership. Owner unavailability freezes the recommendation and stops that owner's tracking authority. A new curator cannot attach to an orphaned slug; source ownership is never inferred from a null owner field or a matching name. A separately noted existing orphaned-slug concern needs focused triage before the import integration is approved.

Before 2A, design an additive canonical ownership relation for imported lineages and update release read/review/sharing/export/lifecycle checks across API, CLI and MCP. Backfill existing records as user-owned with the same owner and grants. Preserve `createdBy` as audit identity. Avoid a service-account workaround, automatic team adoption, or inferring ownership from current grants. Private-source distribution grants must constrain the resulting canonical artifact reads, not just library pages.

### Existing architecture and operations remain canonical

Library snapshots that need a reproducible set can project into existing architecture revisions with exact release/digest refs. Do not introduce a competing bundle registry.

An architecture revision gives atomic **desired-state selection**, not atomic updates across multiple skills or machines. Current per-skill transactions cannot promise whole-plugin atomicity. Coupled groups must either be staged and promoted together by a verified adapter or remain blocked for unattended application. Do not claim “all-or-nothing plugin update” from a batch of independent operations.

If two libraries bind different versions of the same installed identity/path, report `binding-version-conflict`. Identical exact releases can share one effective operation with multiple reasons. Resolve disagreement by an explicit user pin/selection, never last-writer-wins or “newest wins.”

## 4. API and client outline

Proposed `/v1` routes are design candidates, not existing endpoints:

| Operation | Proposed shape | Important behavior |
|---|---|---|
| List/create libraries | `GET/POST /v1/libraries` | Scoped pagination; never disclose hidden counts |
| Read/change library | `GET/PATCH /v1/libraries/:id` | Version precondition; changes and audit together |
| Add/remove entry | `POST /v1/libraries/:id/entries`; entry removal route | Saving a reference does not fetch/execute/install beyond the explicit preview action |
| Preview upstream selection | `POST /v1/source-previews` | Fixed provider adapter; bounded job, immutable result ID, expiry |
| Confirm import | `POST /v1/source-previews/:id/imports` | Actor/scanner/bytes/source/selection rechecked; idempotent submission |
| Configure/check track | Source-track settings and `POST .../:id/checks` | Schedule revisions; a check reads remote state and never changes adoption |
| Read/decide candidate | Candidate list/detail and `POST .../:id/decisions` | Decision binds prior adoption, candidate digest and expected revision |
| Adopt a release | `POST /v1/library-entries/:id/adoptions` | Requires current reviewed release authority and matching provenance |
| Subscribe/read inbox | Subscription and authorized event endpoints | Unsubscribe/read state separate; late dispatch rechecks rights |
| Bind a target | Entry-target binding and automation grant endpoints | Explicit enrollment; no path/token disclosure; MFA where existing policy requires it |
| Resolve bound updates | Authorized entry/adoption resolver used by existing Updates and standalone CLI | Returns the exact adopted release constraint; inaccessible/deleted curation remains pinned and blocked |
| Apply/status | Existing target-operation routes | Extend references, authority checks and reasons; retain existing installer |

Long work returns a bounded job ID, not an open request doing an unbounded crawl. Use stable machine-readable error codes: `source-access-lost`, `source-identity-changed`, `inventory-incomplete`, `preview-expired`, `preview-digest-mismatch`, `unsupported-package`, `unresolved-dependency`, `license-review-required`, `slug-conflict`, `candidate-superseded`, `binding-version-conflict`, `policy-conflict`, `target-drift`, `automation-grant-expired`.

Preserve generic not-found responses for unauthorized private resources. A conflict error may reveal details only after resource authorization. Accept client mutation IDs; reject reusing an ID for different inputs. Concurrent curators use expected revisions, and approval/adoption/outbox creation are transactional. An adopted pointer cannot reference a pending or hidden release.

CLI commands call these API contracts. New API-token scopes distinguish library read/write, source check/import, subscription management and target automation. Existing read tokens remain read-only. Scope names need review with the existing token parser and compatibility checks; do not silently expand existing broad scopes.

Keep standalone installation possible without enabling a companion: an explicit install-from-library option records registry origin, entry and adoption identity locally, then uses the existing installer. Later update checks resolve the library constraint through the API. The exact CLI flag is chosen with parser conventions; the conceptual flow is `install <slug> --library-entry <entryId>`, not a second installer. Removing a library or entry cancels its queued work, revokes grants and leaves the last adopted pin until explicit rebinding/override.

## 5. Policy and automatic application

Keep source eligibility, library approval rules, notification preferences and target execution policy as separate typed inputs. The final decision includes every applicable constraint and reason. Do not flatten them into one mutable effective policy that loses provenance.

Preserve current organization/target policy conjunction and all skipped-release checks. A new library rule can restrict its entry; it cannot relax an organization or target ceiling. The currently installed version, artifact hash, target generation, current adoption and authorization must be checked under the operation's local/server concurrency controls.

Add a dynamic `library-adoption` exact-version constraint to list/preview/queue/claim paths; do not write changing adoption pins into immutable target policy revisions. A revision can be registry-approved without being eligible for a bound library installation. For automation, separately evaluate `requiresUserAction` and adverse dependency/license/capability evidence across the full installed-to-target range. Do not assume the existing change-kind evaluator covers those additional fields.

Before automatic operation creation, validate the current automation authority. Bind exact source snapshot, adoption and artifact identity. At each existing transition, revalidate the grant and current policies. If policy changes, keep the old operation as blocked/superseded with an audit trail and create a new plan only when allowed. Do not trust a policy digest alone as proof that the policy is still current.

Stop after a target failure. A later rollout controller can resume only from an explicit, reviewed recovery decision. Automatic rollback must itself pass current artifact authority, compatibility and local snapshot verification; a failed installation does not authorize delivering a revoked historical release.

## 6. Resource limits, retention and operation

Preserve current per-package limits: 500 files, 1 MiB UTF-8 text and 10 MiB input archive, including generated manifest and notices. These are read from the baseline package code, not proposed increases.

Proposed pilot defaults to validate before release: 100 active tracks per owner scope, 500 entries per library, 10,000 inventory paths per check, 60-second remote-check deadline, at most five attempts with provider-required delays, and one provider request at a time per credential. An operator can lower ceilings. Do not silently truncate; expose `limit-exceeded` with a narrower selection action. Larger repositories can remain reference-only. These limits bound abuse and are not promised scale benchmarks.

Proposed retention: unconfirmed preview bytes expire after 24 hours; unreferenced candidate metadata after 90 days; routine delivery attempts after 30 days; audit metadata according to the existing configured policy. Keep provenance and artifacts while a deliverable release or retained rollback reference needs them. Define deletion/revocation exceptions explicitly and separate metadata retention from continued content delivery. Quarantined private bytes are unavailable even while retention requires storage. Collect neither local paths nor skill execution prompts for library metrics.

Run tracking as an optional worker using the existing npm/runtime and Postgres deployment shape. Provide migration/enablement docs, worker health, queue age, oldest overdue track, last successful check, failure/backoff counts and retry exhaustion. A self-hosted instance without that worker must show scheduling as unavailable. The auth outbox's existence is not evidence that this new worker is operating.

Use a deterministic clock in tests. Restarted workers recover leases; jobs are idempotent. A periodic reconciliation sweep detects abandoned jobs and overdue tracks. Dead-letter cases are operator-actionable without raw source content or tokens. Backups include provenance, grants, adoption history and required artifact bytes; restore must preserve exactly the same entitlement and identity links.

## 7. Verification matrix

| Layer | Required proof |
|---|---|
| Import/core | Repo identity/ref parsing; prefixed/non-SemVer labels; complete selection; support-file changes; changed branch after preview; preserved notices and bytes; invalid native names; concurrent slug/revision allocation; old snapshot accepted after new; explicit missing/conservative release metadata |
| Fetch adapter | Mocked pagination, truncated tree, rate limits, timeout, redirects, unexpected hosts, oversized body, moved tag, transferred/recreated repo, invalid UTF-8, case collisions, unsupported symlinks/LFS/submodules |
| Persistence/API | Cross-user/team/org denial; grant change after preview; source-distribution entitlement; immutable provenance; optimistic conflicts; idempotent candidate/submission/adoption; transaction/outbox failures; durable ownership offboarding |
| Tracking/notifications | Deterministic daily/weekly clock; DST; repeated event/no-op; digest coalescing; duplicate/out-of-order webhook; inaccessible entry redaction; membership removal after enqueue; stale state; exhausted retries |
| Target integration | Only adopted/reviewed bytes, including standalone CLI checks; skipped breaking release or required user action blocks; policy/grant change before claim and promotion; local drift; external manager; conflicting libraries/native names; generation mismatch; offline reconnect; stale lease/fence; rollback denied if artifact authority revoked |
| UI/CLI/MCP | Equivalent authorized actions; keyboard review; empty/blocked/stale states; safe Markdown; no credentials/paths; existing MCP content entitlement unchanged; actual host activation never inferred |
| End-to-end | Disposable registry + real-source pinned import + two snapshots + candidate/adoption + explicit local install/update/rollback, then a separate physical-target automation pilot in phase 3 |

Record failure cases before implementation and prefer persistent API, browser and real-filesystem journeys. Shared ownership, artifact and policy changes require the repository's broader `npm run check` plus disposable Postgres gate. Run `npm run release:artifacts` when CLI/package/export behavior changes. Existing source tests, fresh package installation, hosted health and rendered user flows are different evidence; record each as applicable. Run container-backed checks on the Windows PC where possible. Results belong in the build evidence record.

Do not mutate the example repository, contact its authors, install its plugin, publish imports, register a GitHub App, enable a schedule or enroll a device during specification review. Any real-source rehearsal later uses pinned data and a disposable MySkills environment within the approved slice.

## 8. Engineering handoff and approval boundary

The user authorized implementation of phases 1A–1C on 2026-09-26, including admin-controlled private self-review. Then inspect the current main diff and directly affected callers again; refresh moving baseline facts, not the entire investigation.

Use a dedicated implementation worktree and the existing npm workspaces. Allocate migration numbers at implementation time. No new package manager, dependency, queue service or auth route is assumed. Every new schema/contract field must trace to a requirement above.

Implement and verify 1A, then 1B and 1C within the approved release. Commit, PR, merge, release and deployment remain distinct publication steps under the user's authorization. Roll back an unreleased slice by removing its feature exposure while preserving recoverable data; do not drop production tables as a default rollback.
