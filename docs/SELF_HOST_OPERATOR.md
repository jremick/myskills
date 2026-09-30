# Self-Host Operator Package

The source provides a checksummed Compose bundle and a container-only operator helper. Public images and a signed publisher identity are not established by this source change. Supply independently verified immutable image receipts to `scripts/create-self-host-bundle.mjs`. The bundle records each image's platforms, digest and source labels. Manifest evidence alone does not prove a working installation. See [the investigation](SELF_HOSTING_INVESTIGATION.md) and [deployment prerequisites](DEPLOYMENT.md).

The persistent host needs a local Linux Docker daemon and Compose v2, an HTTPS reverse proxy, SMTP or Resend delivery, and a separate protected HTTPS backup bucket. Host Node/npm is unnecessary. Keep the private config directory outside the bundle, owned by the operator with mode 0700. Answers, runtime, bootstrap, backup and restore files must be owned by that operator with mode 0600. Setup generates fresh database, object and auth credentials. Owner bootstrap is separate and cannot reset an existing account. Remove the private bootstrap inputs after successful sign-in and account setup.

```sh
./myskills.sh setup --config-dir /absolute/private/config --answers-file /absolute/private/answers.json
./myskills.sh preflight --config-dir /absolute/private/config
./myskills.sh up --config-dir /absolute/private/config
./myskills.sh bootstrap --config-dir /absolute/private/config
./myskills.sh status --config-dir /absolute/private/config --json
```

Use the documented fields in `.env.example` and `.env.bootstrap.example`. Never source those files in a shell. The helper reports bounded diagnoses and withholds raw Docker/provider output. `status` compares observed API/web image refs with the expected digests and records backup freshness. It does not prove public HTTPS, email delivery, owner/MFA workflows, restored runtime or publisher authenticity.

All mutating commands reserve `operation.lock`: setup, startup, bootstrap, backup configuration/execution, upgrade and recovery execution. An existing lock rejects another mutation. Signal or failure cleanup releases only the caller's lock. After an uncatchable kill, inspect the exact running operation before removing a stale lock. A lock cannot constrain arbitrary Docker commands or an unpatched historical helper. Keep application writers stopped during coordinated backups that precede migrations.

```sh
./myskills.sh backup config --config-dir /absolute/private/config
./myskills.sh backup execute --config-dir /absolute/private/config
./myskills.sh upgrade /absolute/newer/bundle --accept-forward-migrations --config-dir /absolute/private/config
```

Upgrade validates a newer version, exact source/runtime images, matching storage images and the platform. It pulls target images before stopping writers. It captures a coordinated backup and attaches that completed `backupRunId` to `upgrade-receipt.json` before migration. A standalone backup cannot change an unrelated upgrade receipt.

Before running target SQL, upgrade writes a durable `migration-barrier.json`, then the exact target into `state.json`. This order permits an exact target retry after a crash between writes, including later upgrades. The state now means **required runtime**, even if target startup fails. This also rejects source startup through older helpers that check state identity. Never delete the barrier or rewrite state to the old release after migrations start. Use the exact target helper's `up` to retry migrations/readiness; successful retry records completion. Automatic downgrade is unavailable. Failed or partial forward migrations require the target or isolated recovery.

```sh
./myskills.sh recover plan --config-dir /absolute/private/config
./myskills.sh recover execute COMPLETED_RUN_ID --target-env-file /absolute/private/restore.env --config-dir /absolute/private/config
```

Recovery execution requires Linux host networking and fresh loopback PostgreSQL/object destinations. It executes the same parsed values accepted by preflight, including single-quoted values and literal dollar signs. The maintained restore script selects new database/bucket names, verifies completed-set bytes and all table fingerprints, and retains protected evidence. Its `restoredApplicationRuntime: "not-tested"` receipt remains data-only. Boot the restored API separately and verify original instance/account identity, login/MFA, permissions and exact private artifact bytes before any traffic change. See [Backups](BACKUPS.md).

## Canonical Rehearsal And Evidence

The seven-job controller keeps its existing `verify` contract. `railway-images` reuses its candidate app images and runs `scripts/rehearse-self-host.mjs`. It builds the pinned MinIO target and exact baseline API/web snapshots once. The fixture resolves official `registry:3.1.2` to an immutable digest before startup and uses an ephemeral loopback registry and an isolated HTTPS backup service with a fixture-only CA layer in OPS. Certificate verification stays enabled. A same-host fixture bucket proves the coordinated code path, not external backup durability.

The expected exported artifacts are `host-rehearsal.json` and `host-resources.json`. The parent `resources.json` registers the child ledger and private temporary root. Every transient operator container gets a reserved exact name before creation. Cleanup uses exact names, verified ownership labels and exact Compose project labels. No prune or prefix match is permitted. Timeout/signal cleanup remains owned by the canonical controller; failed child cleanup fails the job and retains the run-ID reservation.

The receipt records candidate/baseline commits, Linux/amd64 native execution, immutable digests, actual source labels, phase timings, completed backup identity, restored login/MFA/permissions/bytes and the supported baseline transition. Raw credentials, tokens, MFA material, package contents and backup archives are removed with the private fixture root.

Baseline `c74ecd33` predates the operator bundle. Its exact API/web images are booted with candidate fresh-only setup/bootstrap tooling, then stopped, backed up, migrated and replaced with the exact candidate. This is a database/runtime upgrade rehearsal. It does not certify the complete `upgrade` command against a historical package that never existed. That claim requires a real baseline release bundle. Shell/CLI stubs and image `--help` checks also remain separate from install/restore evidence.

Only Linux/amd64 is exercised by this new canonical fixture. Arm64 remains unverified here; do not infer lack of support from lack of a run. Preserve any separately established older storage-only arm64 evidence with its original scope. No public image, deployment, production credential, live email or public ingress proof is claimed.

Registry fixture dependency review: official [v3.1.2 release notes](https://github.com/distribution/distribution/releases/tag/v3.1.2), [Docker image inventory](https://raw.githubusercontent.com/docker-library/official-images/master/library/registry) and [deployment guidance](https://distribution.github.io/distribution/about/deploying/) were checked on 2026-10-01. Startup and manifest behavior still require the actual canonical run. A one-commit controller snapshot obtains the exact public baseline through a bounded depth-one fetch into a run-owned temporary Git source. Credential-helper use and prompts are disabled only for that public fetch. Normal Git hooks and configuration remain in force, and the helper verifies the full SHA. Failure stops before fixture installation; it does not change controller history policy.
