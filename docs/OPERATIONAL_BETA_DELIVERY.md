# Operational beta delivery

Status: source implementation and recovery checks passed; local browser journey passed; Railway gates in progress. Started 5 September 2026.

## Intended outcome

An individual or small team can submit a portable skill, understand review feedback,
publish an approved immutable version, find it, install it into a supported Codex
workspace, update it safely, and recover from a failed update. An operator can
identify the deployed release and recover the registry and its package artifacts.

This is an open-source, self-hostable operational beta. Stable release readiness
will also require adoption evidence. Existing accounts, permissions, and data
remain authoritative in the API and Postgres.

## Delivery scope and decisions

- Integrate the unique upgrade and UI changes on current GitHub main in an isolated
  worktree. Preserve all other checkouts, bootstrap work, and private working notes.
- Retain the npm workspace modular monolith, API-owned authorization and audit,
  immutable artifacts, and provider adapters. Refactor at demonstrated failure
  boundaries instead of replacing the architecture.
- Complete one workspace-scoped Codex installation and observation path. Keep
  downloaded, installed, observed, and runtime-recognized claims distinct.
- Use the existing personal Railway project, first its `beta2-staging` environment,
  then production after the candidate passes the acceptance and recovery gates.
- Treat auth, package delivery, companion writes, migrations, and deployment as
  high-risk work. Use negative tests, real Postgres, transactional evidence,
  rendered browser checks, and a recovery rehearsal.
- Do not add SaaS billing, SSO, a marketplace, more provider runtimes, paid model
  execution, or work-profile bootstrap policy. Public npm/tag publication is a
  separate release action; produce and verify the candidate package here.

## Work sequence

1. Establish the candidate: integrate existing work, use the declared Node/npm
   versions, fix the compatible production dependency alerts together, repair
   package license inclusion, and expose an immutable build identity.
2. Repair correctness: target-scoped authorization, policy and consent rechecks,
   exclusive execution, exact receipts, atomic batches and audit; local install
   locking, rollback integrity, immutable intake, and safe filesystem boundaries.
3. Complete the user journey: stable direct links and pagination, author review
   feedback, lifecycle inventory and historical versions, readable package
   content, correct policy editing, and a guided Codex workspace flow.
4. Prove the candidate: source gates, Postgres and concurrency tests, built package
   checks, browser journeys, real CLI/API integration, and isolated backup restore.
5. Deploy the same immutable source to staging API then web. Exercise the complete
   workflow with isolated synthetic data and a disposable local Codex workspace.
   Fix failures and rerun the affected checks before promotion.
6. Capture the production recovery point, promote API then web from the verified
   source, and read back release identity, readiness, logs, and rendered auth and
   registry behavior. Record exact evidence and remaining beta limitations.

## Acceptance criteria and evidence ledger

Each row requires actual evidence before it is marked complete. Passing source
tests alone does not establish deployed behavior or provider runtime recognition.

| ID | Acceptance criterion | Evidence / status |
| --- | --- | --- |
| A01 | Candidate contains current main plus the intended upgrade and UI work; unrelated WIP is preserved. | Integrated main plus the unique upgrade/UI commits in an isolated worktree. Original dirty checkout unchanged on readback; final remote integration pending. |
| A02 | Declared-runtime checks and production audit pass; packed CLI contains its license and runs after fresh installation. | `npm run check`: 769 tests passed on Node 24.19/npm 11.12.1; production audit zero; fresh packed CLI install, LICENSE, validate and scan passed. Node 22/Linux CI pending. |
| A03 | Direct skill URLs stay stable outside the current result page; all authorized skills are reachable once despite many versions. | Registry pagination tests and real Postgres coverage passed. Direct-link component tests passed; deployed browser check pending. |
| A04 | An author sees change-request reasons and scan findings, corrects the package, and completes review with another account. | Feedback/privacy/API tests passed; local rendered author feedback and immutable publication passed. The five-test local browser/API/CLI journey passed. Live staging pending. |
| A05 | An authorized maintainer can find archived or unpublished resources, select historical releases, and restore them. | Local rendered unpublished history and archived inventory checks passed; immutable lifecycle restoration verified. Live staging pending. |
| A06 | Package contents are readable before adoption; onboarding explains ownership and supported installation scope. | Package viewer and onboarding component checks passed; local rendered escaped SKILL.md content inspected. Live staging pending. |
| A07 | A private release cannot leak through a broader target; authorization, consent, policy, lifecycle, and source state are rechecked at execution boundaries. | Production-store negative authorization/policy/consent/source tests passed in the 139-test Postgres gate; live companion journey pending. |
| A08 | Conflicting workers cannot apply simultaneously; expired workers cannot promote; success requires the planned identity and verification evidence. | Lease expiry, target-wide fences, queue/sync exclusivity, exact success, and contention regressions passed. Independent review closed findings; live journey pending. |
| A09 | Batch persistence and audits are atomic; retries return the original operation without state-dependent replay failures. | Real Postgres batch rollback, audit injection, and completed replay tests passed; no duplicate operation/audit on contention retry. |
| A10 | Local installs, updates, recovery, and rollback share a root lock and eligibility checks; rollback bytes are verified and retained until verification succeeds. | 133 CLI tests passed, including root contention, interrupted recovery, unknown edits, rollback tampering, and lease refusal. Same-OS-account hostile directory swaps remain outside the isolation guarantee. |
| A11 | Registry provenance is bound to installs; intake uses one bounded byte snapshot; export and package reads reject symlink escapes. | Bounded directory/ZIP snapshot, traversal/race, provenance, and export tests passed on macOS. Linux runtime evidence awaits CI. |
| A12 | Password length handling prevents bcrypt truncation for new credentials; token storage reports failures honestly; the five admin mutation paths (status, roles, token revocation, registration settings, and provider configuration) commit with their audits. | Password, token-store and real Postgres injected-audit-failure tests passed. Self-service MFA/email/password and invitations retain separate audit sequencing. |
| A13 | Artifact cleanup cannot delete an in-flight committed publication; real Postgres tests exercise production stores and contention. | Real Postgres registry/reaper tests and bounded S3 request tests passed. All old writers/reapers must be drained during rollout. |
| A14 | One standard-frontmatter skill is enrolled, installed, observed, updated, and recovered in a disposable Codex workspace using the built CLI and live staging API. Runtime recognition has separate evidence. | Local complete journey passed, including installed Codex 0.152.0 skills/list recognition without a model turn. Live staging pending. |
| A15 | Browser and CLI checks cover author → review → publish → discover → install → update → rollback → revoke across distinct roles. | Five local full-stack browser tests passed in Comet against Docker API/Postgres/S3/SMTP, including the distinct-role operational journey and exact companion receipts. Live staging pending. |
| A16 | Database and artifact recovery is rehearsed in an isolated destination; the operator has executable migration, rollback, and restore instructions. | Staging data restore: 30 tables/3 artifacts. Production restore: 32 tables/87 artifacts; every table and artifact verified. Restored candidate API passed 18→29 migrations, readiness, restored auth, private S3 delivery and anonymous denial, with email disabled. Private backup/runtime receipts retained outside Git. |
| A17 | Required GitHub checks pass for the candidate; staging API and web expose the same source identity and pass live acceptance. | Pending. |
| A18 | Production API and web expose the promoted source identity; readiness, auth, registry, artifact delivery, and recent logs are verified. | Pending. |

## Architecture and failure boundaries

The registry API owns published identity, visibility, policies, consent, operation
state, and audit. A local companion may only execute a currently authorized plan.
Its filesystem transaction uses exclusive locking and verified bytes. A companion
receipt reports what it checked; it does not establish that an agent runtime loaded
the skill. Provider observation and runtime recognition remain separate evidence.

Object storage and Postgres must be treated as one recovery point. Publication
and cleanup must coordinate around live artifact writes. Schema changes must be
additive or have an explicit compatibility plan. An old application deployment is
only a valid rollback if it can use the current schema and data safely.

## Promotion stop conditions

Do not promote on failed acceptance, unknown source identity, mismatched API/web
source, unsafe migration compatibility, an unverified recovery point, incorrect
Railway environment, uncertain authorization, or exposed secrets. Investigate and
fix routine failures within this scope. Never restore over production to prove
recovery. Keep backups and credentials outside source control and public reports.

## Operational closeout

Record the final commit, required CI runs, package digest, deployment identities,
verification commands and results, recovery evidence, and any unverified behavior.
Do not describe an unrun check or an inferred runtime state as passed. Retain
remaining adoption and stable-release work as explicit follow-up items.

## Evidence collected before live promotion

On Node 24.19.0 and npm 11.12.1, `npm run check` passed 769 tests,
production dependency audit, lint, builds, web types, release policy and the
fresh-package smoke. `npm run test:postgres` passed 139 tests against a
disposable Postgres 17 database. The independent queue and CLI reviews closed
their confirmed findings after targeted regressions.

A production snapshot taken at 2026-09-04 21:33 UTC restored 32 tables and 87
artifacts into newly created loopback destinations. The candidate API applied
11 additional migrations to that copy and passed readiness, restored session,
admin/anonymous access, and private S3 artifact digest checks. Email was disabled;
no production writes were performed by the rehearsal. Backup material and
account-bearing runtime receipts remain private and outside source control.

This is bounded beta evidence. It does not establish recovery-time guarantees,
continuous backup scheduling, a hostile same-user filesystem sandbox, external
email deliverability, full architecture graph execution, or model behavior.

The five-test local full-stack gate also passed with Comet, Docker API/web,
Postgres, MinIO and Mailpit. It exercised password/MFA login, invitations,
author feedback, review, publication, lifecycle restoration, package inspection,
CLI install/update/rollback, companion drift refusal and exact receipts, target
revocation and release revocation. With runtime proof enabled, Codex 0.152.0
recognized the installed standard-frontmatter skill through `skills/list`; no
model turn was created. The test's temporary containers were removed afterward.
