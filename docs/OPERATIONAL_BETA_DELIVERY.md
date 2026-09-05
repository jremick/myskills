# Operational beta delivery

Status: operational beta deployed and verified in staging and production on 5 September 2026. Stable-release limits are recorded below.

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
| A01 | Candidate contains current main plus the intended upgrade and UI work; unrelated WIP is preserved. | [PR #55](https://github.com/jremick/myskills/pull/55) integrated the operational beta. [PR #57](https://github.com/jremick/myskills/pull/57) added only the two nginx cache fixes. Final application source is `d8c7179789bdbf0930fe0e496081377f6c63cd20`; original dirty checkout preserved. |
| A02 | Declared-runtime checks and production audit pass; packed CLI contains its license and runs after fresh installation. | Linux Node 22 and 24 each passed 798 source tests and the required check gate. Production audit passed; fresh packed CLI install, LICENSE, validate and scan passed. |
| A03 | Direct skill URLs stay stable outside the current result page; all authorized skills are reachable once despite many versions. | Pagination, direct-link component, and real Postgres tests passed. Production Comet preserved an authenticated private skill's direct link under an unrelated search filter. |
| A04 | An author sees change-request reasons and scan findings, corrects the package, and completes review with another account. | Live staging verified exact author feedback, scan evidence, immutable correction, and publication across distinct author and maintainer accounts. |
| A05 | An authorized maintainer can find archived or unpublished resources, select historical releases, and restore them. | Live staging verified rendered unpublished history, archived inventory, restoration, and unchanged artifact bytes. |
| A06 | Package contents are readable before adoption; onboarding explains ownership and supported installation scope. | Package viewer and onboarding component checks passed. Staging rendered escaped SKILL.md before installation; production rendered SKILL.md and an available supporting file as literal text. |
| A07 | A private release cannot leak through a broader target; authorization, consent, policy, lifecycle, and source state are rechecked at execution boundaries. | The 148-test Postgres gate passed on both Node lines, including private-target boundaries and hidden release history. Live staging blocked an upgrade crossing a breaking release at preview, scheduling, and claim, then verified exact pin selection. |
| A08 | Conflicting workers cannot apply simultaneously; expired workers cannot promote; success requires the planned identity and verification evidence. | Lease expiry, target-wide fences, queue/sync exclusivity, and contention regressions passed. Live staging verified exact companion receipts and refusal after target revocation. |
| A09 | Batch persistence and audits are atomic; retries return the original operation without state-dependent replay failures. | Real Postgres batch rollback, audit injection, and contention retry tests passed. Live staging replay returned the completed operation and its original receipt. |
| A10 | Local installs, updates, recovery, and rollback share a root lock and eligibility checks; rollback bytes are verified and retained until verification succeeds. | CLI locking, interrupted recovery, unknown edits, rollback tampering, and lease refusal passed the Node 22/24 gates. Live staging preserved local edits and verified update/rollback bytes. Hostile swaps by the same OS account remain outside the isolation guarantee. |
| A11 | Registry provenance is bound to installs; intake uses one bounded byte snapshot; export and package reads reject symlink escapes. | Bounded directory/ZIP snapshot, traversal/race, provenance, and export checks passed on macOS and in the Linux Node 22/24 gates. |
| A12 | Password length handling prevents bcrypt truncation for new credentials; token storage reports failures honestly; the five admin mutation paths (status, roles, token revocation, registration settings, and provider configuration) commit with their audits. | Password, token-store and real Postgres injected-audit-failure tests passed. Self-service MFA/email/password and invitations retain separate audit sequencing. |
| A13 | Artifact cleanup cannot delete an in-flight committed publication; real Postgres tests exercise production stores and contention. | Real Postgres registry/reaper and bounded S3 tests passed. Old API deployments were removed before the new artifact protocol started in staging and production. |
| A14 | One standard-frontmatter skill is enrolled, installed, observed, updated, and recovered in a disposable Codex workspace using the built CLI and live staging API. Runtime recognition has separate evidence. | Live staging passed the complete workspace journey. A separate local Codex `skills/list` result confirmed recognition without a model turn. |
| A15 | Browser and CLI checks cover author → review → publish → discover → install → update → rollback → revoke across distinct roles. | Linux Node 22 and 24 each passed eight mocked browser tests and five full-stack tests. Final live staging Comet passed 20 checks in 135 seconds, including policy denial, exact pin, update, rollback, and revocation. |
| A16 | Database and artifact recovery is rehearsed in an isolated destination; the operator has executable migration, rollback, and restore instructions. | Final logical recovery verified all 50 tables at migration 29 and all 87 artifacts, including 86 object-backed packages, with no source writes. Earlier isolated runtime recovery verified migrations 18→29, readiness, auth, private delivery, and anonymous denial with email disabled. The final copy did not repeat that runtime check. |
| A17 | Required GitHub checks pass for the candidate; staging API and web expose the same source identity and pass live acceptance. | Final main [CI](https://github.com/jremick/myskills/actions/runs/33932735785) and [CodeQL](https://github.com/jremick/myskills/actions/runs/33932735819) passed at `d8c7179`. Final staging identity, readiness, HTML headers, and the complete 20-check journey passed. |
| A18 | Production API and web expose the promoted source identity; readiness, auth, registry, artifact delivery, and recent logs are verified. | Final `d8c7179` preflight, 29 migrations, eight HTTP readbacks, seven HTML/header checks, and all 12 Comet/API checks using read requests passed. These include owner cookie auth, exact private delivery, literal text, anonymous mobile, and session preservation. Package access creates normal audit events; no fixture or administrative change requests were sent. Sampled API/nginx logs had no actual errors or 5xx. |

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

The records below identify the verified source, checks, package, deployments,
and recovery points. Account-bearing browser and runtime reports remain private.
Adoption and stable-release work remain explicit follow-up items.

## Source and rollout evidence

The final application revision is
`d8c7179789bdbf0930fe0e496081377f6c63cd20`, merged through PR #57 at
2026-09-05 00:21:58 UTC after its required candidate checks passed. It changes
only two nginx configurations from the first beta.5 deployment. Main
[CI](https://github.com/jremick/myskills/actions/runs/33932735785) and
[CodeQL](https://github.com/jremick/myskills/actions/runs/33932735819) passed.
GitHub reported zero open Dependabot and CodeQL alerts after the final merge on
5 September 2026. Later documentation and test-only commits do not change the
deployed application's embedded revision.

The freshly packed CLI passed installation, license inclusion, validation, and
scanning. Its tarball SHA-256 is
`9b27929dfedcf2195760a3980d0471f3f301227b373e038a410076dd6ea8302b`;
the installed CLI bundle SHA-256 is
`dbf0512e64011668ad0d9f282d725e92af974c5971605b0622a2a9f87cb0e75c`.
The follow-up release was authorized after operational verification. Annotated
tag `v0.1.0-beta.5` targets `0721e0b54b8f9c7ad78d7194a57f2c8216e4a3a2`.
The intervening changes are documentation and one test readiness wait; the
application code and packed CLI bytes match the deployed candidate. The clean
local canonical gate and the tag's [Release workflow](https://github.com/jremick/myskills/actions/runs/33937140879)
passed, including all five deployment image builds. The source archive from
GitHub matches the locally verified archive byte for byte. The
[GitHub prerelease](https://github.com/jremick/myskills/releases/tag/v0.1.0-beta.5)
is published with the verified CLI tarball, source archive, metadata, and
checksums. Its instructions install the CLI directly from the release asset.
npm publication remains pending maintainer authentication; the npm `beta`
channel is still `0.1.0-beta.4` and `latest` is still `0.1.0-alpha.3`.

Final staging API `f69f826e-f71b-4baa-9dcf-3e414be69658` and web
`1154add2-b701-4bbc-8d40-be52e123f910` succeeded from that exact revision.
Preflight, 29 migrations, registry instance identity, direct API/web/proxy
responses, and the seven-check HTML header probe passed. The full staging
journey passed 20 checks in 135 seconds, with separate Codex recognition and
temporary MFA cleanup verified. The capture mailbox stayed private, unused
Resend values were cleared, and address-aware proxy trust was verified.

Final production API `0e8af8f9-c385-4fbd-a236-a05912a59793` and web
`07c178e6-81d7-4fe6-a239-8a8c9ab16598` deployments succeeded from that same
source. Preflight passed without warnings. Eight identity/health HTTP readbacks,
seven HTML/header checks, and all 12 Comet/API checks using read requests passed.
The browser check made 21 API GETs and reported no page errors. It sent no
fixture or administrative change requests. Allowed and denied package downloads
create normal `artifact.bundle` audit events in production. The check verified
private direct links under an unrelated filter, owner cookie auth,
exact package bytes, literal file display, anonymous mobile navigation at
390 × 844 with loaded registry/skill detail and no horizontal overflow, and
preservation of the owner session.
Sampled API/nginx logs through 00:37:54 UTC had no actual errors or 5xx responses;
Railway's error-level nginx startup entries were `[notice]` messages.

An existing-browser check during the first deployment found that its cache could
serve beta.2 HTML and assets until reload, although fresh HTTP requests returned beta.5.
Root and deep-link HTML lacked an explicit `Cache-Control` response header.
The two-file nginx fix passed 30 baseline/30 fixed HTTP response checks, 168
security-header value checks, official entrypoint/environment substitution, and
syntax validation. JavaScript, CSS, and API proxy behavior are unchanged. HTML
cached before this fix needs one reload to obtain the new revalidation policy.
An existing authenticated Codex browser tab passed that check: one reload showed
the current Approved skills and Manage skills interface, and subsequent Registry
navigation retained it without errors or loss of session.
Final staging and production confirmed `no-cache` on HTML for both 200 and 304
responses, preserved security headers and hashed assets, and `no-store` on
`/version.json`.

## Recovery evidence and beta limits

The final logical recovery point was captured at 2026-09-05 00:31:16 UTC and
verified by 00:33:47 UTC. Every table and artifact matched the snapshot: 50 tables
at the 29-migration schema, 87 artifacts, 86 object-backed packages, and 3,394,519
artifact bytes. It used new isolated destinations and made no source writes.
The earlier recovered API check remains the runtime evidence for migrations,
auth, and private delivery; the final recovery verified data only. The 32-table
copy captured before the first production promotion remains historical evidence.
The temporary test/recovery containers and clean release worktree were removed
after verification. Verified backup files and release evidence were retained
outside source control.

A Railway manual Postgres snapshot was created at 2026-09-04 23:38:10 UTC.
That physical snapshot has not been restored by this work. It is additional
backup material, separate from the verified database-and-artifact logical copy.
Account-bearing evidence, backup contents, and private package identities remain
in operator-held records outside source control.

Stable release readiness still needs sustained adoption evidence, external email
delivery evidence, historical secret retention, and observed scheduled backup
and notification behavior. The follow-up below establishes the first retained-set
restore and the daily schedule. A hostile same-user filesystem sandbox, full
architecture graph execution, and model behavior remain outside the proven scope.

## Authorized operational follow-up

The [backup follow-up](BACKUPS.md#live-beta-record-5-september-2026) is merged and
deployed. Its first 30-second capture verified 50 tables and 87 artifacts. Restore
of that exact retained remote set passed in 24 seconds, followed by recovered API
readiness, authorization, MFA decryption, and private package delivery with email
disabled. Daily 16:00 UTC scheduling and an independent 06:15 Melbourne-time
freshness check are configured. The first clock-triggered run and notification
delivery remain pending. The job receives database and object-storage references,
never the API's `AUTH_SECRET`. Historical MFA recovery also requires the matching
key in an approved secret store; its retention location has not been verified.

The [independent-user pilot](PILOT.md) is ready for participant selection. No
independent-use results or external email delivery have been recorded. The
production notification provider has a send-only key; its presence does not
establish delivery to a recipient's inbox.
