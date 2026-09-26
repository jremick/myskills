# Libraries: evidence and design review

Date: 2026-09-26. Status: local specification review. Read with the [feature specification](2026-09-26-library-feature-spec.md) and [delivery plan](2026-09-26-library-delivery-plan.md).

## Source of truth and investigation scope

GitHub `jremick/myskills` main was read through the GitHub API at `7a0fc44e6a1cabaabfdcf494c3cc96db4cf7d3cc`, then fetched and inspected in an isolated managed worktree. The original checkout is `codex/work-team-dry-run-planner` at `ec9af68` and contains unrelated uncommitted work. It was not used as the final implementation baseline.

Inspection covered the directly relevant library/import roadmap, package validation, submission ownership, upgrade policies, target operations, notification outbox, tenant contracts and host-integration ADR. It was not a broad repository audit or a production verification. No implementation, tests, source installation, schedules, source credentials, messages to people or publication occurred.

## Baseline evidence

| Claim | Inspected source |
|---|---|
| API/Postgres owns canonical registry state | [Architecture](../ARCHITECTURE.md) |
| GitHub import and continuous source tracking are planned | [AUTHOR-1](../ROADMAP.md#authoring-and-imports-author-1) |
| Strict manifest requires SemVer, license and valid slug | [Manifest schema](../../packages/skill-package/src/manifest.ts) |
| Package limits are 500 files, 1 MiB text and 10 MiB input archive | [Package reader constants](../../packages/skill-package/src/package-path.ts) |
| Submission ownership is currently user-based | [Submission types](../../apps/api/src/submissions/types.ts) |
| Current organization and target policies combine as constraints | [Policy resolution](../../apps/api/src/upgrade-policies/service.ts), [composition](../../packages/core/src/skill-upgrade-policy.ts) |
| Cumulative release changes and live policy checks already exist | [Target operations](../../apps/api/src/target-operations/service.ts) |
| Default release classification is maintenance; import needs explicit handling | [Release metadata](../../packages/core/src/skill-updates.ts) |
| Auth outbox exists, but is not a library notification system | [Auth worker](../../apps/api/src/auth/notification-outbox.ts), [server wiring](../../apps/api/src/server.ts) |
| Organization grant ceiling counts grants per skill | [Organization policy](../../packages/core/src/organization-tenancy.ts) |
| Generated, handed-off, observed and runtime-verified delivery differ | [ADR 0005](../adr/0005-ai-platform-integration-boundaries.md) |

## Example repository readback

GitHub API readback identified public repo `EveryInc/compound-engineering-plugin`, repository ID `1073224021`, with MIT license metadata. Selected README, manifest, license and `ce-plan` content were read as untrusted source data; no instructions from that repository were executed.

| Reference | Exact observation |
|---|---|
| Main commit | `a763b392c3c05faa1a383c0d228b7e95200ecc90` |
| Latest observed stable release | `compound-engineering-v3.29.0`, release ID `396790340`, published `2026-09-25T17:13:46Z` |
| Resolved release tag commit | `4043703d32c5df9e35f22757dee22f3a72a99c66`; verified using Git ref readback, not inferred from `target_commitish` |
| Tree completeness | Recursive trees for both commits returned `truncated: false` |
| Root skills | 36 in each independently read tree |
| Release `ce-plan` inventory | 38 files, 589,431 blob bytes under `skills/ce-plan/` |
| Main versus release for `ce-plan` | Zero changed/added/removed blobs in that directory |

This proves a useful specification example: repository revisions can differ while a selected skill does not. It does not prove import compatibility, a complete semantic dependency graph, valid package conversion or host activation.

Public evidence: [main tree](https://github.com/EveryInc/compound-engineering-plugin/tree/a763b392c3c05faa1a383c0d228b7e95200ecc90), [release tree](https://github.com/EveryInc/compound-engineering-plugin/tree/4043703d32c5df9e35f22757dee22f3a72a99c66), [release notes](https://github.com/EveryInc/compound-engineering-plugin/releases/tag/compound-engineering-v3.29.0), [plugin manifest](https://github.com/EveryInc/compound-engineering-plugin/blob/a763b392c3c05faa1a383c0d228b7e95200ecc90/.claude-plugin/plugin.json).

## External operational guidance checked

- [GitHub REST best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api): prefer webhooks when available, otherwise efficient conditional polling; respect backoff and pagination. The design does not assume a fixed request quota.
- [GitHub webhook failures](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries): failed deliveries are not automatically redelivered. The design includes reconciliation.
- [GitHub webhook best practices](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks): validate incoming deliveries and use delivery identity for duplicate handling.
- [GitHub App best practices](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/best-practices-for-creating-a-github-app): narrow repository and permission scopes. The private-source phase requires a deliberate connection design.

## Opus collaboration and reconciliation

The user requested Opus. Two bounded, subscription-backed Claude Code sessions used `claude-opus-5-5` at `xhigh`. The first provided independent product scope; the second reviewed the integrated proposal against current main. Read-only profiles allowed local file reading/search; the parent owns all document edits and reconciles findings with authoritative source.

The first session's transcript confirmed model `claude-opus-5-5`, with 15 Read, 11 Grep and 2 Glob calls, and no file-write tools. It inspected the original local branch, so its implementation findings required current-main verification.

| Opus finding or recommendation | Parent decision |
|---|---|
| Separate source checks, recipient notifications and target application | Accepted as independent settings and authority boundaries |
| Compare selected skills and support files, not only repo releases | Accepted; supported by the live `ce-plan` tree comparison |
| Separate upstream labels and ordered imported versions | Accepted; use explicit import revisions and provenance |
| Unknown imports must not inherit maintenance classification | Accepted; explicit conservative mapping and user-action requirement |
| Import notices and complete supporting files | Accepted; incomplete/unsupported plugin packages remain reference-only |
| Target policy overrides organization policy; skipped breaking releases can be hidden | Stale branch findings; current main already composes ceilings and evaluates the change range. No new repair scope proposed |
| Maintenance windows can use the narrowest scope | Rejected; preserve conjunction of all applicable current windows |
| Organization can grant only 25 skills | Incorrect interpretation; the setting is organization grants per skill. No library entitlement bypass proposed |
| Library-level grant should give access to all entries | Rejected as a security shortcut; library visibility cannot replace artifact/source authorization |
| Urgent upstream security labels bypass mute | Narrowed; upstream labels are evidence, registry revocation is authoritative, and mandatory company notices require explicit policy |
| Whole plugin can be represented by an architecture revision | Accepted for exact desired-state sets only; no claim of atomic multi-skill application |
| Personal/public first, then shared/private and automation | Accepted as a proposed default pending the user's product priorities |

The second transcript confirmed `claude-opus-5-5`, with 12 Read, 9 Grep and 1 Glob calls. It returned 11 findings and no writes or test execution. It read the feature draft and current baseline while the parent was still writing the companion documents; it did not review the final delivery-plan file. Codex reconciled its findings and performed the final document checks.

| Integrated-review finding | Resolution in this proposal |
|---|---|
| Global slug collisions, manifest limits and native install identity | Allocate opaque-suffixed imported slugs; preserve native names; block unsupported mapping and native-name collisions. Baseline CLI install paths use the registry slug |
| Adoption did not constrain existing Updates | Add a dynamic exact `library-adoption` constraint to discovery, preview, direct updates, queue and claim, including standalone CLI installations |
| Every import needs an instance reviewer | Keep that lane explicit for the pilot; record strictly private self-review as an alternative requiring a product decision |
| Missing change metadata defaults to maintenance | Reject missing import metadata; show conservative breaking/user-action mapping until explicitly classified |
| Accepting old candidates could create apparently newer updates | Bind acceptance to current lineage head and source order; supersede old candidates; require explicit revert/track-change decisions |
| Skipped user-action requirements could be missed | Add automation checks for required user actions and adverse evidence over the full installed-to-target range; reuse existing change-kind checks |
| Personal lineage owner can leave a team | Limit the first team slice to references; freeze unavailable-owner lineages; require durable ownership before shared import |
| Candidate granularity and coupled application were unclear | One candidate per lineage/snapshot/import profile; grouped review is not atomic multi-skill installation |
| Unsubscribe, stop following and deletion were conflated | Define distinct lifecycle effects; cancel queued work/revoke grants; preserve files and last adopted pins until explicit rebinding |
| Public source disappearance and private access loss were conflated | Separate unavailable/deleted public source, public-to-private rights review, and revoked private connection delivery gates |
| Missing companion files and broad first release | Companion files are now present and linked; 1A is a bounded manual personal slice, with later gates and explicit team-reference limits |

The reviewer proposed silently returning detached installs to ordinary registry update evaluation. Codex chose to retain the last adopted pin until an explicit management choice, because deletion should not broaden update authority. The reviewer also suggested redefining a platform support flag; the proposal instead preserves the existing adapter contract and keeps runtime activation evidence separate.

### Scoped concern requiring implementation-time triage

Opus identified a possible existing orphaned-slug path. Codex confirmed that [submission intake](../../apps/api/src/submissions/postgres-submission-store.ts) rejects another owner only when `existingSkill.ownerUserId` is truthy. This is a source observation, not a reproduced vulnerability or an assertion of published unauthorized bytes; existing reviewer gates still apply. The future import path must never attach to an existing lineage merely because its owner is null. Reproduce and resolve the directly affected ownership behavior before integrating imports; no application code was changed during this specification task.

### Document validation

The final artifact check covers all three new Markdown files, relative file/anchor links, whitespace and unique requirement IDs LIB-01 through LIB-18. The separate delivery matrix maps the requirements to phases and validation. Source claims about policy, package limits, ownership and target paths were checked against the refreshed baseline. These checks do not establish feature behavior, production readiness, or Opus approval of the parent's final edits.

## Evidence limits

This deliverable is a product and engineering proposal, not an implemented feature. No current library UI, source worker, private GitHub connection or auto-update pilot was created or tested. Existing behavior is described from source, with historical roadmap text treated as context. External values are observations at the stated date and immutable refs where available.

The original unrelated checkout work remains outside this draft's scope. Only the three new planning documents in the isolated worktree belong to this task. The source/reference and requirement checks validate document consistency and local links; they are not application test results.
