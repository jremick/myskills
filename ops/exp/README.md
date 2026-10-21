# EXP Phase 0

Application source is fixed at the approved SHA. Images are built natively on EXP
from the pushed build commit. `images.conf` records immutable application image IDs
and third-party registry digests. CI copies under `ci/` are inactive.

Install shell scripts under `/mnt/cache/appdata/myskills/bin/`. Install env files
under `secrets/` as root:600, with `secrets/`, `backups/`, and `import/` root:700.
Env examples contain names only. Never create `tunnel.env` during Phase 0.

Install `/boot/config/myskills-fw.sh` before starting any workload.
Create the seven named bridges, then apply and verify the firewall.
Use `run-<service>.sh create` to create stopped containers.
`run-<service>.sh run` starts the service and must be used only when authorized.
Phase 0 starts only this app's Postgres. API, web, migrate and backup remain
stopped. Only the owner-role one-shot may run migrations.

The pinned images were built from `b8e064629c90406d81e44a17a162a376168deaf5`,
whose application source is `3deeb95e442353e67446fd83f79055959f4a54ab`.
Later commits containing runtime scripts do not change that image provenance.

The tunnel starts only through `bash /boot/config/myskills-fw.sh start`, after
firewall verification. Missing `tunnel.env` skips startup. It never auto-restarts.
No published ports, docker.sock, privileged mode, or host networking are used.

R2 and age recipients remain blank. Backup/restore scripts are unscheduled.
See `BACKUPS.md` for the separate later verification requirements.

DNS-1a permits public DNS only for the six named sources through 1.1.1.1 and
1.0.0.1. The other containers cannot resolve public names. Both firewall scripts
and the shared watchdog check all seven explicit bridges. Missing bridges or
rules stop both tunnels and emit a host log and Unraid alert.

Install `cf-ips.sh` and `watchdog.sh` as `/boot/config/cf-ips.sh` and
`/boot/config/railway-exit-watchdog.sh`. Append `go-hook.sh` after the existing
management startup line. The hook validates the live Cloudflare IPv4 list at
boot and retains the last valid copy if fetching or validation fails. Both
backups have HTTPS access only to those ranges. Scoped OUTPUT drops prevent
host-originated new connections to both backup addresses: 172.30.40.5 on
br-myskills and 172.30.54.2 on br-fb-bk. Both canonical policies, fail-closed
startup checks and the shared watchdog require the MySkills backup drop.

Run 12 uses 1.5 GiB for ForgetBase freshclam (`--memory 1536m --memory-swap 1536m`)
with `TestDatabases yes`. The normal check and a full download into disposable
tmpfs storage passed with no OOM; the full test peaked at about 697 MiB.
Clamd retains `Foreground yes` and records EICAR FOUND in Docker logs.
The direct scan path was used because the EXP API database is not migrated.
No clamd configuration or hardening change was needed for detection logging.
The installed seven-bridge firewall remains active. Both database backup roles
exist. The backup contract is pending design (capacity), not a STOP 0 blocker.
The monitor is not configured; default push-from-host. Uploader candidates and
the host monitor wrapper remain local and are not adopted during Phase 0.
Keep backups, application containers, migrations and real tunnels stopped.

GHCR/CI publishing remains deferred until the account has the workflow scope.

EXP Node runtimes require CA packages >= 20261020-r0 and use `--use-openssl-ca`
with `SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt`. Keep the flag if adding
`NODE_OPTIONS` to an env file or run script. Runtime-stage builds check eMudhra
rejection and Resend TLS. Remove this workaround after the Node release with
nodejs/node#66871 ships and the pinned base is bumped. Railway production is
unchanged and needs separate approval.
