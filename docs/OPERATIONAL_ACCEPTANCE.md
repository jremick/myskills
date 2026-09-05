# Operational acceptance and recovery rehearsal

The operational journey uses the real API, production stores, object-backed
package artifacts, and the built CLI. It creates synthetic data under a unique
`acceptance-*` skill slug and uses distinct author, maintainer, and consumer
accounts. It does not reset a database, change instance-wide sharing settings,
execute package hooks, or call an AI model.

Build the candidate CLI through the repository build gate before running this
journey. `MYSKILLS_ACCEPTANCE_CLI_PATH` can select a freshly installed candidate
CLI bundle instead of `apps/cli/dist/index.js`.

```sh
node --test scripts/test/operational-safety.test.mjs
node scripts/run-operational-acceptance.mjs --execute --report /private/new-report.json
```

The report path must not already exist. Reports contain check names, synthetic
identities, and artifact digests. They do not contain tokens, passwords, package
contents, or private object keys. CLI errors are bounded and do not reproduce raw
subprocess output. A failed run is not retried automatically.

## Destination and actor configuration

Inject the following through the existing project authentication helper. Do not
print environment values or place secrets in command arguments.

| Variable | Purpose |
| --- | --- |
| `MYSKILLS_ACCEPTANCE_API_URL` | Exact API base, including `/api` when using the web proxy. Defaults to `MYSKILLS_E2E_BASE_URL/api`. |
| `MYSKILLS_ACCEPTANCE_ENVIRONMENT` | `local` requires loopback. `staging` requires the verified instance identifier. Production fixture writes are refused. |
| `MYSKILLS_ACCEPTANCE_INSTANCE_ID` | Independently read-back staging instance ID; checked before fixture writes. |
| `MYSKILLS_ACCEPTANCE_AUTHOR_TOKEN` | Existing dedicated author session bearer. |
| `MYSKILLS_ACCEPTANCE_REVIEWER_TOKEN` | Existing dedicated MFA-verified maintainer session bearer. |
| `MYSKILLS_ACCEPTANCE_CONSUMER_TOKEN` | Existing dedicated unprivileged consumer session bearer. |

Supply all three actor tokens together when reusing fixture accounts. Supplied
sessions remain under the operator's control. The script verifies current roles
and distinct identities through `/v1/me` before proceeding.

For first-run local or staging fixtures, omit actor tokens and provide
`MYSKILLS_ACCEPTANCE_OWNER_TOKEN` plus the private capture mailbox URL in
`MYSKILLS_E2E_MAILPIT_URL`. The script invites three `example.test` accounts,
redeems their captured invitation tokens, assigns author/maintainer roles, and
enrolls reviewer MFA. It never changes registration policy. In the local E2E
runner, existing owner email/password and recovery-code index 6 are a fallback
when an owner session was not supplied. Created sessions are revoked after the
run, including failures. Synthetic users and audit records are retained; published
fixture releases are revoked on successful completion.

API rate limits remain enabled. Fresh fixture provisioning uses three registration
requests and four actor login requests. Reuse dedicated sessions for repeated
staging trials. Do not reset a live rate-limit table to make a retry pass.

The Playwright journey under `apps/web/test/e2e/fullstack/` adds rendered author
feedback, readable package files, unpublished release history, archived skill
inventory, blocked upgrade review, and revocation evidence. It restores real
server-authenticated sessions into separate browser states; the regular full-stack
suite covers interactive login. It uses no route mocks. Screenshots and test
reports must remain private when run against a non-disposable environment.

The built CLI also enrolls a disposable Codex workspace, installs the corrected
package into `.agents/skills`, and uploads a filesystem observation. A temporary
reviewer-owned token has only `targets:execute` and `skills:read` scopes.

With corrected version `0.1.1` installed, the fixture publishes `0.1.2` as a
breaking release and `0.2.0` as a fix. It queues the later fix under the default
policy, then saves a fix-only target policy. The preview must block the entire
crossed range and retain both visible release notes. New scheduling must return
`TARGET_OPERATION_POLICY_CHANGE_KIND_BLOCKED`, and the scoped executor must
receive no claim for the previously queued update. The browser must show the
policy reason and both release notes while selection and `Queue exact update`
remain disabled. The queued fixture operation is cancelled and installed bytes
must remain unchanged.

The fixture then allows all change kinds and pins exactly `0.1.2` while `0.2.0`
remains available. Preview and scheduling must bind the pinned version and its
artifact, without including the later release. After cancellation, it restores
and reads back the original policy values before normal updates resume. This
creates a target policy override with those values; it does not remove that
override or restore inheritance from the default policy source.

Service and Postgres regressions separately cover formerly published versions
that become unpublished, revoked, deleted, or unsafe. Their change kinds still
restrict later upgrades. Hidden release notes and artifacts remain absent from
the preview, and never-published drafts do not enter the upgrade range. Core
tests also require exact pin matching: an unavailable or incompatible pin must
report a blocker instead of silently selecting another release.

The companion must refuse an update when the fixture has a local edit, preserve
that edit and the installed version, then update successfully after the fixture is
repaired. The script checks exact success receipts, idempotent replay, verified
rollback bytes, and refusal of queued work after target revocation. The token is
revoked at the end and expires after 15 minutes even if cleanup cannot complete.

This tests refusal of local drift and recovery through verified rollback. It does
not inject a process crash during promotion. The CLI transaction and concurrency
tests cover interrupted promotion and concurrent access.

An operator can import `runOperationalAcceptance` and supply the optional
`afterWorkspaceInstall` callback to inspect the disposable workspace while its
verified files still exist. The callback receives the absolute workspace path,
slug, version, target ID, and reviewer session. Keep credentials in memory. Use
Codex's local skill discovery interface for runtime recognition without starting
a model turn, and record that result separately. The acceptance report continues
to label runtime recognition `not-tested` because it cannot verify an external
callback's evidence.

The full-stack browser journey can run this independent check when the operator
sets `MYSKILLS_ACCEPTANCE_RUNTIME_PROOF=codex` and the installed `codex` binary
is available. It attaches a separate `codex-runtime-recognition` result from
`skills/list`; no model thread or turn is created. To check an existing managed
workspace directly:

```sh
node scripts/prove-codex-recognition.mjs /absolute/workspace skill-slug
```

On 5 September 2026, final live staging Comet passed 20 checks in 135 seconds
against source `d8c7179789bdbf0930fe0e496081377f6c63cd20`. The separate
Codex discovery result confirmed recognition without a model turn, and temporary
MFA cleanup passed. The [delivery ledger](OPERATIONAL_BETA_DELIVERY.md) records
the exact CI, package, deployment, and production verification status. Public npm
and tag publication remain separate actions.

Final production verification on that revision passed eight identity/health HTTP
readbacks, seven HTML/header checks, and 12 read-only Comet/API checks. It used
the existing owner session for private delivery and a fresh anonymous mobile
context for loaded registry/skill detail. Package bytes, literal file display,
direct links, session preservation, and absence of horizontal overflow were verified.
No production fixture writes or model turns occurred. HTML cached before the
revalidation fix needs one reload to obtain the new policy.

## Database and object recovery

The recovery tool reads one PostgreSQL repeatable-read snapshot, copies every
artifact referenced by that snapshot, and uses `pg_dump --snapshot` for the same
database state. Every copied object must match the snapshot's byte length,
SHA-256, content type, and stored digest. Missing objects fail the run unless the
snapshot contains the explicitly supported legacy inline payload. At least one
real object-backed package is required so seed-only data cannot satisfy this gate.

```sh
node scripts/rehearse-registry-recovery.mjs --plan
node scripts/rehearse-registry-recovery.mjs --execute
```

`--plan` validates configuration without network or file writes. `--execute`
requires a PostgreSQL client version compatible with the source server, existing
Node dependencies, and these narrowly injected variables:

| Variable family | Purpose |
| --- | --- |
| `MYSKILLS_RECOVERY_SOURCE_DATABASE_URL` | Read access to the source database, including snapshot export and dump. Only the optional `sslmode` URL parameter is accepted. |
| `MYSKILLS_RECOVERY_SOURCE_S3_ENDPOINT`, `_BUCKET`, `_REGION`, `_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY`, optional `_SESSION_TOKEN` | Source artifact store. Only reads occur on this store. |
| `MYSKILLS_RECOVERY_DESTINATION_POSTGRES_URL` | Loopback administrative database with permission to create a new database. |
| `MYSKILLS_RECOVERY_DESTINATION_S3_ENDPOINT`, `_REGION`, `_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY`, optional `_SESSION_TOKEN` | Loopback disposable object store with bucket creation permission. |
| `MYSKILLS_RECOVERY_PG_BIN` | Optional absolute directory containing `pg_dump` and `pg_restore`. |
| `MYSKILLS_RECOVERY_OUTPUT_PARENT` | Existing private output directory outside the checkout. Defaults to the system temporary directory. |
| `MYSKILLS_RECOVERY_MAXIMUM_BYTES` | Maximum database archive size and, separately, total artifact size. Defaults to 512 MiB; bounded at 2 GiB. |

The tool creates random `myskills_recovery_*` database and `myskills-recovery-*`
bucket names, refuses existing destinations, and permits only loopback restores.
`pg_restore --clean` operates exclusively on that newly created database's empty
schema; it never targets a caller-supplied database name. Source connections are
passed to PostgreSQL tools through environment variables, not command arguments.

After restore, every public table's row count and content fingerprint must equal
the exported snapshot, and every restored object is read back and verified.
SHA-256 authenticates the copied archive and artifact bytes. The per-table MD5
fingerprint is an equality check, not a cryptographic signature. The bounded
rehearsal supports 10,000 artifacts and one million rows per table. An object
must fit the application's 14 MiB artifact limit.

Backups contain private application data and credential hashes. Directories use
mode `0700`, files use `0600`, and backup contents are never added to the checkout.
The tool retains both successful and partial recovery destinations for inspection.
The report names those generated destinations and records duration, object/table
counts, archive digest, and snapshot time. The operator owns their later cleanup.
Use the approved encrypted backup store for long-term retention.

Runtime recovery needs a separate check. Before promotion, point an isolated copy
of the candidate API at the recovered database and bucket, then verify readiness,
login, permissions, and package delivery without sending real email. Keep that
runtime result and the Codex skill-recognition result separate from the API/CLI
and recovery reports.

The final logical rehearsal, captured at 2026-09-05 00:31:16 UTC, verified all
50 tables at migration 29 and all 87 artifacts, including 86 object-backed
packages, without source writes. The earlier recovered API run remains the
evidence for migrations 18→29, auth, and private delivery; the final copy verified
data only. The 32-table rehearsal preceded the first production promotion.
A Railway physical Postgres snapshot created at 2026-09-04 23:38:10 UTC was not
restored by this work. A database-only snapshot also needs its matching artifact
recovery point.

This rehearsal does not configure recurring backups, retention, or recovery-time
targets. Operators must define and test those controls for their own deployment.
Stable release readiness also needs sustained adoption evidence. Capture-mailbox
success does not establish external email deliverability, and local skill
recognition does not establish model behavior or full architecture execution.
