# EXP Phase 0

Application source is fixed at the approved SHA. Images are built natively on EXP
from the pushed build commit. `images.conf` records immutable application image IDs
and third-party registry digests. CI copies under `ci/` are inactive.

Install shell scripts under `/mnt/cache/appdata/myskills/bin/`. Install env files
under `secrets/` as root:600, with `secrets/`, `backups/`, and `import/` root:700.
Env examples contain names only. Never create `tunnel.env` during Phase 0.

Install `/boot/config/myskills-fw.sh` and verify its rules before creating networks.
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

DNS-1 remains open: Docker forwards external DNS to the host's LAN resolvers,
which the approved firewall blocks. Do not add DNS exceptions or start a real
tunnel until the design decision is approved. GHCR/CI publishing is deferred
until the account has the required workflow scope.
