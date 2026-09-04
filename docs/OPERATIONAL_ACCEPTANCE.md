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
inventory, and revocation evidence. It restores real
server-authenticated sessions into separate browser states; the regular full-stack
suite covers interactive login. It uses no route mocks. Screenshots and test
reports must remain private when run against a non-disposable environment.

The built CLI also enrolls a disposable Codex workspace, installs the corrected
package into `.agents/skills`, and uploads a filesystem observation. A temporary
reviewer-owned token has only `targets:execute` and `skills:read` scopes. The
companion must refuse an update when the fixture has a local edit, preserve that
edit and the installed version, then update successfully after the fixture is
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

This proves restored data, not a running recovered service or an agent loading a
skill. Before promotion, point an isolated copy of the candidate API at the
recovered database and bucket, then verify readiness, login, permissions, and
package delivery without sending real email. Keep that runtime result and the
Codex skill-recognition result separate from the API/CLI and recovery reports.
