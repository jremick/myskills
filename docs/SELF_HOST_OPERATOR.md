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

Single-quote every dollar-bearing environment value. Unquoted dollar signs are refused before startup or upgrade quiescence because Compose can interpolate them. The public bootstrap command validates its protected file before starting the bootstrap container. The helper opens protected inputs with `O_NOFOLLOW`, checks the opened file's type, size, mode and owner, and reads from that same descriptor with a 1 MiB limit. This protects the final component from symlink replacement. It does not protect against a malicious process with the same host privilege controlling ancestor directories or changing an already opened inode.

All mutating commands reserve `operation.lock`: setup, startup, bootstrap, backup configuration/execution, upgrade and recovery execution. An existing lock rejects another mutation. Signal or failure cleanup releases only the caller's lock. After an uncatchable kill, inspect the exact running operation before removing a stale lock. A lock cannot constrain arbitrary Docker commands or an unpatched historical helper. Keep application writers stopped during coordinated backups that precede migrations.

```sh
./myskills.sh backup config --config-dir /absolute/private/config
./myskills.sh backup execute --config-dir /absolute/private/config
./myskills.sh upgrade /absolute/newer/bundle --accept-forward-migrations --config-dir /absolute/private/config
```

Upgrade validates a newer version, exact source/runtime images, matching storage images and the platform. It pulls target images before stopping writers. It captures a coordinated backup and attaches that completed `backupRunId` to `upgrade-receipt.json` before migration. A standalone backup cannot change an unrelated upgrade receipt.

Before running target SQL, upgrade writes a durable `migration-barrier.json`, then the exact target into `state.json`. This order permits an exact target retry after a crash between writes, including later upgrades. The state now means **required runtime**, even if target startup fails. This also rejects source startup through older helpers that check state identity. Never delete the barrier or rewrite state to the old release after migrations start. Use the exact target helper's `up` to retry migrations/readiness; successful retry records completion. Automatic downgrade is unavailable. Failed or partial forward migrations require the target or isolated recovery.

Each JSON update syncs its temporary file before rename and the containing directory after rename. The barrier's directory sync completes before the state write begins. Both writes must complete before SQL. Any write, rename or sync failure stops migration. These guarantees depend on the host filesystem and storage honoring `fsync`; local fault tests establish call order and failure handling, not physical power-loss behavior.

```sh
./myskills.sh recover plan --config-dir /absolute/private/config
./myskills.sh recover execute COMPLETED_RUN_ID --target-env-file /absolute/private/restore.env --config-dir /absolute/private/config
```

Recovery execution requires Linux host networking and fresh loopback PostgreSQL/object destinations. It executes the same parsed values accepted by preflight, including single-quoted values and literal dollar signs. The maintained restore script selects new database/bucket names, verifies completed-set bytes and all table fingerprints, and retains protected evidence. Its `restoredApplicationRuntime: "not-tested"` receipt remains data-only. Boot the restored API separately and verify original instance/account identity, login/MFA, permissions and exact private artifact bytes before any traffic change. See [Backups](BACKUPS.md).

## Canonical Rehearsal And Evidence

The seven-job controller keeps its existing `verify` contract. `railway-images` reuses its candidate app images and runs `scripts/rehearse-self-host.mjs`. It builds the pinned MinIO target and exact baseline API/web snapshots once. The fixture resolves official `registry:3.1.2` to an immutable digest before startup and uses an ephemeral loopback registry and an isolated HTTPS backup service with a fixture-only CA layer in OPS. Certificate verification stays enabled. A same-host fixture bucket proves the coordinated code path, not external backup durability.

The disposable backup fixture publishes Docker-assigned TCP9000 only on host loopback. It reads the single owned bridge container address before it creates a certificate with both that direct IPv4 and `127.0.0.1` as SANs. A bounded startup gate prevents MinIO from starting before the certificate files are complete. Network, container, endpoint and publication readbacks must remain unchanged before the gate opens. Native Ubuntu verifies the published loopback endpoint with that CA and the published web readiness endpoint. Application drivers use `web:80/api` and `web:80` on the exact owned Compose bridge. Recovery ports are allocated in Docker's host namespace. Its owned PostgreSQL, MinIO object/console listeners and restored API bind to loopback in that same namespace. Exact service ownership, image, command, running state and authenticated destination readiness are checked before recovery writes. The host-network bucket driver and recovery helper use the direct backup container IPv4 on port9000. Coordinated OPS uses the same direct backup endpoint from its source MinIO network namespace, attached to the owned backup bridge. These fixture routes keep the operator's real HTTPS backup endpoint and loopback restore checks unchanged. They do not certify Docker Desktop as a persistent operator host.

The expected exported artifacts are `host-rehearsal.json` and `host-resources.json`. The parent `resources.json` registers the child ledger and private temporary root. Every transient operator container gets a reserved exact name before creation. Cleanup uses exact names, verified ownership labels and exact Compose project labels. No prune or prefix match is permitted. Timeout/signal cleanup remains owned by the canonical controller; failed child cleanup fails the job and retains the run-ID reservation.

Both the operator shim and direct rehearsal calls record each Compose `up`, `run` or `create` before dispatch. An interrupted request remains unresolved across cleanup attempts, even after visible project resources are removed. Empty listings cannot prove that a delayed daemon request is finished. The canonical interruption fixture tests this with a supervised real Compose creation: it interrupts the client, observes initial absence, permits delayed creation, and requires an independent success acknowledgement for that exact request before settling its fixture reservation. Ordinary interrupted operations have no such acknowledgement and remain cleanup failures pending operator reconciliation.

A second canonical fault interrupts the actual Compose CLI during its health wait. Its single-container, single-network fixture retains an independent acknowledgement of the complete creation set before interruption. Cleanup must still report unresolved creation on repeated attempts; only the explicit fixture acknowledgement permits reconciliation. These bounded fault fixtures do not turn arbitrary daemon absence into completion evidence.

The receipt records candidate/baseline commits, Linux/amd64 native execution, immutable digests, actual source labels, phase timings, completed backup identity, restored login/MFA/permissions/bytes and the supported baseline transition. Raw credentials, tokens, MFA material, package contents and backup archives are removed with the private fixture root.

Prepared restore and upgrade checks require a real fresh TOTP code against the original encrypted factor, recovery-code login, denial of an authenticated fixture non-owner's private artifact request, and continued denial of a fixture session revoked before backup. They retain original instance/account, owner, anonymous-denial, architecture, scan and exact-byte checks. The non-owner is generated through the existing auth store in the run-owned database; no email provider is needed. These checks establish fixture acceptance only after canonical execution. They do not prove a user's MFA or live external-host consent.

Baseline `c74ecd33` predates the operator bundle. Its exact API/web images are booted with candidate fresh-only setup/bootstrap tooling, then stopped, backed up, migrated and replaced with the exact candidate. This is a database/runtime upgrade rehearsal. It does not certify the complete `upgrade` command against a historical package that never existed. That claim requires a real baseline release bundle. Shell/CLI stubs and image `--help` checks also remain separate from install/restore evidence.

Only Linux/amd64 is exercised by this new canonical fixture. Arm64 remains unverified here; do not infer lack of support from lack of a run. Preserve any separately established older storage-only arm64 evidence with its original scope. No public image, deployment, production credential, live email or public ingress proof is claimed.

Registry fixture dependency review: official [v3.1.2 release notes](https://github.com/distribution/distribution/releases/tag/v3.1.2), [Docker image inventory](https://raw.githubusercontent.com/docker-library/official-images/master/library/registry) and [deployment guidance](https://distribution.github.io/distribution/about/deploying/) were checked on 2026-10-01. Startup and manifest behavior still require the actual canonical run. A one-commit controller snapshot obtains the exact public baseline through a bounded depth-one fetch into a run-owned temporary Git source. Credential-helper use and prompts are disabled only for that public fetch. Normal Git hooks and configuration remain in force, and the helper verifies the full SHA. Failure stops before fixture installation; it does not change controller history policy.
