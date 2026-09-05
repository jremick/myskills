# Coordinated registry backups

The backup job stores one consistent PostgreSQL snapshot together with every artifact referenced by that snapshot. It runs independently of the API and web applications. The initial schedule must remain disabled until an operator restores a completed set downloaded from the backup bucket.

The beta defaults are one capture daily at **16:00 UTC**, seven successful **UTC capture days**, and a 26-hour freshness alert. The nominal recovery point objective is 24 hours; the recovery time objective is one hour. These are targets, not measured guarantees. Scheduling delay, capture duration, failed jobs, and operator response affect recovery. Record both timings during the first drill.

## Storage and source boundary

Use a separate private S3 bucket for backups. Its credentials belong only to the backup job and the approved recovery/monitoring tools. The API must not receive backup-bucket credentials. The runner refuses a backup bucket with the same name as the artifact source bucket and derives its namespace as `registry-v1/<instance-id>/`; callers cannot supply an arbitrary deletion prefix.

Railway buckets are private and encrypted at rest. They use authenticated public HTTPS endpoints. New buckets normally use virtual-hosted URLs; older buckets can require path-style URLs. Check each bucket's Credentials metadata independently. Railway does not currently provide bucket snapshots, versioning, Object Lock, or lifecycle configuration, so this script implements retention. Uploads count as service egress. A second bucket in the same project does not protect against loss or compromise of the entire Railway account/project. [Railway storage documentation](https://docs.railway.com/storage-buckets)

The script's source operations are limited to reads, session settings, and a transient PostgreSQL advisory lock. It does not create roles, run migrations, seed data, update application rows, list the source bucket, or delete source artifacts. The configured job reuses the approved PostgreSQL and API artifact-storage credential references; a separate read-only database identity has not been provisioned. Its credentials can therefore have broader privileges than the script exercises. A dedicated database role with the read privileges required by `pg_dump`, including public tables and sequences, would be a separate credential-hardening change. Existing database volume snapshots can remain supplementary; they do not coordinate the artifact bucket with the database snapshot.

The source instance ID is verified inside the exported snapshot against `public.instance_settings`. A wrong registry fails before artifact copying. An advisory lock excludes concurrent backup runs; a lost database connection cancels the job and removes permission to prune. This lock does not block API publication. The current artifact publication/reconciliation contract preserves committed references and immutable object bytes. Operators must not perform direct S3 deletion, hard purges, or concurrent schema changes during capture. Future destructive maintenance must coordinate with backup capture.

## Environment contract

Inject credentials through approved service references or a private operator environment file outside the checkout. Do not paste values into commands, logs, issues, or this document. The backup service does **not** need `AUTH_SECRET`, email credentials, an API token, or destination PostgreSQL credentials.

| Variable | Use |
| --- | --- |
| `MYSKILLS_BACKUP_INSTANCE_ID` | Required existing registry identity; safe letters, digits, `_`, or `-`, at most 100 characters |
| `MYSKILLS_RECOVERY_SOURCE_DATABASE_URL` | Source PostgreSQL URL; use Railway private networking for the job |
| `MYSKILLS_RECOVERY_SOURCE_S3_ENDPOINT` | Artifact storage endpoint |
| `MYSKILLS_RECOVERY_SOURCE_S3_BUCKET` | Artifact source bucket |
| `MYSKILLS_RECOVERY_SOURCE_S3_REGION` | Source region; defaults to `us-east-1` |
| `MYSKILLS_RECOVERY_SOURCE_S3_ACCESS_KEY_ID` | Source storage credential reference |
| `MYSKILLS_RECOVERY_SOURCE_S3_SECRET_ACCESS_KEY` | Source storage credential reference |
| `MYSKILLS_RECOVERY_SOURCE_S3_FORCE_PATH_STYLE` | Literal `true` or `false`; default `true` preserves the legacy rehearsal |
| `MYSKILLS_RECOVERY_BACKUP_S3_ENDPOINT` | Separate backup storage endpoint |
| `MYSKILLS_RECOVERY_BACKUP_S3_BUCKET` | Separate backup bucket |
| `MYSKILLS_RECOVERY_BACKUP_S3_REGION` | Backup region; defaults to `us-east-1` |
| `MYSKILLS_RECOVERY_BACKUP_S3_ACCESS_KEY_ID` | Backup storage credential reference |
| `MYSKILLS_RECOVERY_BACKUP_S3_SECRET_ACCESS_KEY` | Backup storage credential reference |
| `MYSKILLS_RECOVERY_BACKUP_S3_FORCE_PATH_STYLE` | Independent literal `true` or `false`; configure from bucket metadata |
| `MYSKILLS_RECOVERY_MAXIMUM_BYTES` | Default `536870912`; applies separately to dump bytes and aggregate artifact bytes; range 14 MiB–2 GiB |
| `MYSKILLS_RECOVERY_TIMEOUT_MS` | Default `600000`; range 1,000–1,800,000 ms |
| `MYSKILLS_RECOVERY_OUTPUT_PARENT` | Existing private temporary parent outside the checkout; default OS temporary directory |
| `MYSKILLS_RECOVERY_PG_BIN` | Optional absolute directory containing matching `pg_dump` and `pg_restore` binaries |

Each S3 role also accepts an optional `MYSKILLS_RECOVERY_<ROLE>_S3_SESSION_TOKEN`. The `--status` mode requires only the backup S3 variables, instance ID, and optional bounds. The restore command also requires `MYSKILLS_RECOVERY_DESTINATION_POSTGRES_URL` and the `MYSKILLS_RECOVERY_DESTINATION_S3_{ENDPOINT,REGION,ACCESS_KEY_ID,SECRET_ACCESS_KEY,FORCE_PATH_STYLE}` variables. Destination PostgreSQL and S3 endpoints must be loopback. The restore command never connects to the source database or source bucket.

## Commands and native Railway settings

Run configuration validation without connecting or writing:

```sh
node scripts/run-registry-backup.mjs --plan
```

Run one backup, or check the latest completed capture independently:

```sh
node scripts/run-registry-backup.mjs --execute
node scripts/run-registry-backup.mjs --status
```

Both commands emit a small JSON status and exit nonzero on failure. Status also exits nonzero if no completed backup exists, the latest capture is older than 26 hours, or metadata/listing verification fails. It verifies the completed marker and manifest; it does not re-download all artifact/database bytes. Use the isolated restore drill to prove retained data recovery.

Create one private Railway service in the existing project/environment with these native settings:

- Dockerfile: `Dockerfile.backup`, repository root as build context.
- Service variable: `RAILWAY_DOCKERFILE_PATH=Dockerfile.backup`. Keep this explicit
  as well as the native Dockerfile setting; a configuration redeploy otherwise
  selected Railpack during the first live setup. [Custom Dockerfile path](https://docs.railway.com/builds/dockerfiles#custom-dockerfile-path)
- Start command: `node scripts/run-registry-backup.mjs --execute`.
- One replica; restart policy `NEVER`; no public domain, port, healthcheck, or persistent volume.
- Cron schedule **unset** for initial manual capture and restore proof. After proof, the candidate is `0 16 * * *` (16:00 UTC daily).
- Configure deployment triggers deliberately so ordinary application changes do not redeploy the backup service unexpectedly. Record the deployed image/revision alongside the drill evidence.
- Allocate temporary storage for a dump plus all referenced objects: approximately 1 GiB plus overhead at default limits. Set the service memory limit and measure peak usage during the first run; the dump and remote readback stream rather than loading the archive into memory.

`Dockerfile.backup` uses Node 24.19.0, npm 11.12.1, and PostgreSQL 18 client tools. It installs existing workspace dependencies without building application packages and does not execute migrations. The image and live service must be built and verified by the operator before use.

Railway expects cron jobs to exit and does not automatically terminate stuck runs. A still-active deployment causes the next run to be skipped. The scripts therefore have a whole-job deadline, per-operation cancellation, and a final process watchdog. [Railway cron jobs](https://docs.railway.com/cron-jobs)

Use native settings and read back the resulting deployment configuration. Railway has deprecated its older Config as Code mechanism; no new `railway.toml` is required here. [Railway configuration reference](https://docs.railway.com/config-as-code/reference)

## Consistency, completion, and retention

The capture opens `REPEATABLE READ READ ONLY`, exports a snapshot, reads every public table fingerprint and artifact reference, copies and checks object bytes, and passes that exact snapshot to `pg_dump --format=custom --schema=public --no-owner --no-acl`. Only then does it commit the source read transaction. The exported snapshot remains open throughout capture. [PostgreSQL synchronized snapshots](https://www.postgresql.org/docs/18/app-pgdump.html)

Archived, revoked, unpublished, and historical artifacts remain in scope. Inline artifacts are copied from the same snapshot when the corresponding source object is absent, and are also present in the database dump. Scheduled backups also support empty and inline-only registries. The legacy rehearsal requires at least one real object-backed package to establish object-storage recovery evidence.

Each unique run prefix contains `database.dump`, `objects/<artifact-uuid>.bin`, `manifest.json`, and finally `complete.json`. The runner uses conditional creation, checks every uploaded file by full remote SHA-256/length readback, verifies the manifest, and writes the completion marker last. It verifies that marker before retention. SHA-256 detects corrupted bytes; it is not protection against an attacker who can replace both data and manifests with valid new hashes.

Retention keeps the newest completed recovery point for each of the seven newest distinct UTC capture days. Same-day retries do not consume historical days. Only after the new set passes readback may older valid completed sets be pruned. Candidates are fully enumerated and validated before any deletion; a changed completion marker stops deletion. Deletion removes the marker first, so interruption cannot leave a visibly complete set whose data was only partly removed.

**Malformed sets and partial attempts are never automatically deleted.** Missing markers are skipped, while a marker with a missing/corrupt manifest fails verification and prevents retention. Unexpected namespace objects, foreign prefixes, missing/repeated pagination tokens, or excessive listing size also prevent deletion. An interrupted deletion is retained as a partial set for explicit operator inspection. Inspect the exact namespace and preserve the known good recovery points before separately authorizing cleanup.

The job bounds each artifact to 14 MiB, the artifact count to 10,000, each public table to one million rows, and the table count to 256. Metadata reads are bounded to 8 MiB per manifest and 64 MiB across the candidate collection. Listings allow at most 128 run prefixes and 16 pages; one run deletes at most 16 completed sets. SQL and PostgreSQL child processes have 180-second limits, connections ten seconds, and S3 operations 30 seconds including response bodies. The default whole-job limit is ten minutes. Bounds fail closed; growth beyond them requires an operator decision, not silent truncation.

Scheduled capture removes its local temporary data after success or failure. Uploaded incomplete attempts remain private for inspection. Restore/rehearsal directories and failure reports remain mode `0700`/`0600` outside the checkout. Before creating either restore destination, the script writes the generated names to private `destinations.json`. If creation, restoration, or verification fails, private `failure.json` also retains those names for exact inspection and cleanup. These are reserved destination names, not proof that both resources were created. Confirm existence before cleanup. Public failure status excludes the names and raw provider errors.

## First stored-backup restore proof

1. Leave the schedule disabled. Run the deployed backup service once, retain its JSON status, and identify its exact `runId` and manifest SHA-256.
2. Prepare new isolated PostgreSQL 18 and S3 services on loopback. Supply the approved backup-bucket credentials and local destination credentials to the restore process; it exercises only read operations against the backup bucket, regardless of those credentials' broader privileges. Use a fresh temporary directory.
3. Validate and restore that exact retained run:

   ```sh
   node scripts/restore-registry-backup.mjs --plan RUN_ID
   node scripts/restore-registry-backup.mjs --execute RUN_ID
   ```

4. The command validates bounded remote metadata, downloads and verifies the dump and every artifact, then creates random new destination database/bucket names. It never uses `pg_restore --create`, a caller-selected database name, or an existing destination bucket. It restores object-backed artifacts, retains inline payloads in PostgreSQL, and compares every public table fingerprint and object hash/metadata to the captured manifest.
5. Start the recovered API separately with isolated runtime configuration and email disabled. Verify readiness, login/MFA as applicable, permission boundaries, and actual private package delivery. A `restoredApplicationRuntime: "not-tested"` result means the script verified data only. The dump excludes cluster roles and external configuration; recover those from the operator runbook and approved configuration sources.
6. Record source capture time, retained manifest hash, deployed backup image/revision, actual table/artifact counts, download/restore duration, runtime results, and required secret availability. The earlier manual 50-table/87-artifact result does not prove this stored set.
7. Test a failed run and owner notification, and independently run `--status` through existing monitoring. Only after successful stored-set and runtime proof should the operator enable the candidate daily schedule. Observe the next automatic run to confirm recurrence.

The original workflow remains available as `node scripts/rehearse-registry-recovery.mjs --plan | --execute`. It captures a **new** source snapshot and restores it immediately. It therefore cannot substitute for downloading and restoring an existing remote backup.

## Required secret recovery and failure visibility

`AUTH_SECRET` is passed as `mfaSecretKey` in `apps/api/src/server.ts`. `apps/api/src/auth/service.ts` derives an AES-256-GCM key from it to encrypt stored TOTP factor secrets. The matching historical `AUTH_SECRET` must remain recoverable from the approved secret store for as long as its database backups are retained. Replacing it alone does not restore existing TOTP enrollment. The runner neither needs nor records the secret or a fingerprint of it. The presence of a similarly named local environment variable is not proof that it matches production.

Keep the recovered API isolated until operators reconcile configuration, post-snapshot account/package revocations, and credential state. A database restore reverts application data to capture time, including revocation records.

Wire failed-run events to the existing owner notification channel. Run `--status` independently through existing monitoring; no new email credential or notification provider is required by these scripts. A schedule that never starts cannot send its own failure notification. Railway deployment webhooks are best effort, so an event alone does not establish backup freshness. Verify the real notification path and stale-success check before calling alerting operational. [Railway webhooks](https://docs.railway.com/observability/webhooks)

## Focused validation

```sh
node --test scripts/test/registry-backup.test.mjs scripts/test/operational-safety.test.mjs
npx --no-install eslint scripts/lib/registry-recovery.mjs scripts/lib/registry-backup.mjs scripts/rehearse-registry-recovery.mjs scripts/run-registry-backup.mjs scripts/restore-registry-backup.mjs scripts/test/registry-backup.test.mjs --max-warnings=0
```

The focused tests cover snapshot and inline-byte handling, namespace/source identity boundaries, corruption, incomplete sets, retention days, pagination refusal, overlap, connection loss, stalled streams, the whole-job deadline, independent path styles, stale status, download-before-restore verification, and legacy rehearsal behavior. They use local fake transports and do not replace the live PostgreSQL 18/object-store restore drill.

## Live beta record: 5 September 2026

[PR #59](https://github.com/jremick/myskills/pull/59) merged the runner at
`bd2e8ee030e3db8eef956517d7bd4d587c5be738`. Required PR checks and subsequent
main [CI](https://github.com/jremick/myskills/actions/runs/33938901776) and
[CodeQL](https://github.com/jremick/myskills/actions/runs/33938901728) passed.
The final focused recovery suite passed 27 tests. API/web application code and
their deployed revision remain unchanged.

The first production capture completed in 30 seconds. It verified 50 tables,
87 artifacts (86 object-backed), and 3,394,519 artifact bytes. Run
`2026-09-05T02-24-28.363Z_6afebe6519c7559d` has manifest SHA-256
`302415341843a497856a6800d2d19d3126083ff22b1f8a44ccc92e38af87c87c`.
Downloading and restoring that exact retained set into fresh local PostgreSQL 18
and S3 destinations passed in 24 seconds. The recovered API passed readiness,
restored owner access, anonymous denial, MFA-secret decryption, and exact private
package delivery with email disabled. All 29 migrations were already present.
Elapsed time from download start through the API check was 96 seconds; this
does not measure incident response or replacement cloud infrastructure setup.
Disposable restore services were removed; private backup and evidence files
were retained outside the repository.

Production `registry-backup` is now configured for 16:00 UTC daily, one replica,
restart `NEVER`, and no public domain. Its scheduled deployment
`1309565e-756e-4efc-ae47-13a373da239f` reports `SUCCESS` and `cronReady`.
It uses the same image digest as the successful first run:
`sha256:51b5cfb6f1c8980e2a252aa2fd4af3604a7e3c8b1b206fb5b0c6fefb69d28cda`.
The earlier configuration redeploy `d4679cd0-7b63-4997-897b-afe41b87d0c3`
failed at build time before running the job; the explicit Dockerfile selector
fixed it. No active Railway warning or critical notification remained at readback.

An independent local Codex check is configured for 06:15 Melbourne time daily.
Its exact Railway-injected `--status` command passed after the restore. It will
report the first automatic execution or an actionable failure, missed run, stale
capture, or verification problem. It depends on the local host being available;
notification delivery and the first clock-triggered run at 16:00 UTC on
5 September remain unobserved. Seven-day retention is tested policy, not seven
days of collected history. Historical `AUTH_SECRET` retention in an independent
approved secret store remains unverified.
