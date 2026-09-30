#!/bin/sh
# Run on the operator's Docker Compose host. Never source public or private env files.
set -eu
umask 077

die() { printf '%s\n' "MySkills operator: $1" >&2; exit 1; }
usage() {
  printf '%s\n' 'Usage: ./myskills.sh COMMAND --config-dir /absolute/private/config' \
    '  setup [--answers-file /absolute/protected/answers.json]' \
    '  preflight | up | bootstrap | status [--json] | diagnostics' \
    '  backup config | status | execute' \
    '  upgrade /absolute/target/bundle --accept-forward-migrations' \
    '  recover plan' \
    '  recover execute BACKUP_RUN_ID --target-env-file /absolute/protected/restore.env' \
    'Persistent HTTPS reverse proxy and SMTP/Resend delivery are operator prerequisites.' \
    'Integrity checks do not authenticate a publisher. Recovery execution requires Linux and new empty loopback destinations.'
}

case ${1:-} in --help|-h|'') usage; exit 0 ;; esac
command=$1; shift
config_dir=; answers_file=; target_bundle=; target_env=; run_id=; action=; consent=false; json=false
case "$command" in
  setup|preflight|up|bootstrap|status|diagnostics) ;;
  backup|recover) action=${1:-}; [ -n "$action" ] || die 'a subcommand is required.'; shift
    if [ "$command" = recover ] && [ "$action" = execute ]; then run_id=${1:-}; [ -n "$run_id" ] || die 'a completed backup run ID is required.'; shift; fi ;;
  upgrade) target_bundle=${1:-}; [ -n "$target_bundle" ] || die 'an absolute target bundle is required.'; shift ;;
  *) die 'unknown command; use --help.' ;;
esac
while [ "$#" -gt 0 ]; do
  case $1 in
    --config-dir) [ -z "$config_dir" ] && [ "$#" -ge 2 ] || die 'invalid config directory option.'; config_dir=$2; shift 2 ;;
    --answers-file) [ "$command" = setup ] && [ -z "$answers_file" ] && [ "$#" -ge 2 ] || die 'answers file is only accepted for setup.'; answers_file=$2; shift 2 ;;
    --target-env-file) [ "$command" = recover ] && [ "$action" = execute ] && [ -z "$target_env" ] && [ "$#" -ge 2 ] || die 'target environment is only accepted for explicit recovery.'; target_env=$2; shift 2 ;;
    --accept-forward-migrations) [ "$command" = upgrade ] && [ "$consent" = false ] || die 'invalid migration consent option.'; consent=true; shift ;;
    --json) [ "$command" = status ] && [ "$json" = false ] || die 'JSON receipt is only accepted for status.'; json=true; shift ;;
    *) die 'unknown option; secrets must be supplied through prompts or a protected answers file.' ;;
  esac
done
case "$command:$action" in backup:config|backup:status|backup:execute|recover:plan|recover:execute|setup:|preflight:|up:|bootstrap:|status:|diagnostics:|upgrade:) ;; *) die 'unknown subcommand.' ;; esac
if [ "$command" = upgrade ] && [ "$consent" != true ]; then die 'upgrade requires --accept-forward-migrations; automatic downgrade is never performed.'; fi
safe_path() { case $1 in /*) ;; *) die 'paths must be absolute.' ;; esac; case $1 in *','*|*':'*|*'
'*) die 'paths cannot contain colon, comma or newline.' ;; esac; }
safe_path "$config_dir"
bundle=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)

sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d ' ' -f 1; else shasum -a 256 "$1" | cut -d ' ' -f 1; fi; }
verify_bundle() {
  directory=$1
  [ -f "$directory/SHA256SUMS" ] && [ ! -L "$directory/SHA256SUMS" ] || die 'bundle checksums are missing or symlinked.'
  count=0
  while IFS= read -r line || [ -n "$line" ]; do
    hash=${line%%  *}; file=${line#*  }
    [ "${#hash}" -eq 64 ] && printf '%s\n' "$hash" | LC_ALL=C grep -Eq '^[a-f0-9]{64}$' || die 'invalid checksum digest.'
    printf '%s\n' "$file" | LC_ALL=C grep -Eq '^[A-Za-z0-9._/-]+$' || die 'invalid checksum filename.'
    case "$file" in /*|*/../*|../*|*/..|*/./*|./*|*/.|*//*|.|..) die 'unsafe bundle checksum path.' ;; esac
    [ "$line" = "$hash  $file" ] && [ -f "$directory/$file" ] && [ ! -L "$directory/$file" ] || die 'bundle checksum file is missing or unsafe.'
    [ "$(sha "$directory/$file")" = "$hash" ] || die 'bundle checksum verification failed.'
    count=$((count + 1))
  done < "$directory/SHA256SUMS"
  [ "$count" -ge 6 ] || die 'bundle checksum inventory is incomplete.'
  for file in compose.yml myskills.sh .env.example .env.bootstrap.example release.env release-manifest.json; do
    LC_ALL=C grep -Eq "^[a-f0-9]{64}  $file\$" "$directory/SHA256SUMS" || die 'bundle checksum inventory is incomplete.'
  done
  # Only public digest refs and source identifiers are accepted. No eval or env sourcing.
  [ "$(wc -l < "$directory/release.env" | tr -d ' ')" -eq 8 ] || die 'release metadata must contain exactly eight public values.'
  for name in API WEB MCP OPS MINIO POSTGRES; do
    [ "$(LC_ALL=C grep -Ec "^MYSKILLS_${name}_IMAGE=[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}\$" "$directory/release.env")" -eq 1 ] || die 'release images must be pinned to immutable digests.'
  done
  LC_ALL=C grep -Eq '^MYSKILLS_SOURCE_COMMIT=[a-f0-9]{40}$' "$directory/release.env" || die 'release source commit is invalid.'
  LC_ALL=C grep -Eq '^MYSKILLS_VERSION=[0-9]+\.[0-9]+\.[0-9]+(-beta\.[0-9]+)?$' "$directory/release.env" || die 'release version is invalid.'
}
verify_bundle "$bundle"
[ -z "$target_bundle" ] || { safe_path "$target_bundle"; target_bundle=$(CDPATH= cd -- "$target_bundle" && pwd -P); verify_bundle "$target_bundle"; }
[ -z "$answers_file" ] || { safe_path "$answers_file"; [ -f "$answers_file" ] && [ ! -L "$answers_file" ] || die 'answers file is missing or symlinked.'; }
[ -z "$target_env" ] || { safe_path "$target_env"; [ -f "$target_env" ] && [ ! -L "$target_env" ] || die 'restore configuration is missing or symlinked.'; }
if [ "$command" = setup ] && [ ! -e "$config_dir" ]; then mkdir -m 700 -- "$config_dir" || die 'could not reserve the private config directory.'; fi
[ -d "$config_dir" ] && [ ! -L "$config_dir" ] || die 'config directory is missing or symlinked.'
config_dir=$(CDPATH= cd -- "$config_dir" && pwd -P)
ops_image=$(sed -n 's/^MYSKILLS_OPS_IMAGE=//p' "$bundle/release.env")
platform=linux/amd64
case $(uname -m) in aarch64|arm64) platform=linux/arm64 ;; x86_64|amd64) ;; *) die 'operator architecture must be amd64 or arm64.' ;; esac
command -v docker >/dev/null 2>&1 || die 'Docker with Compose v2 is required on the operator host.'

# Retain only local Docker configuration, not application/provider credentials or
# environment overrides that could replace checksummed image refs in Compose.
docker_config=${DOCKER_CONFIG:-${HOME:-}/.docker}
docker_call() { env -i PATH="$PATH" HOME="${HOME:-}" DOCKER_CONFIG="$docker_config" docker "$@"; }
case ${DOCKER_HOST:-} in ''|unix://*) ;; *) die 'remote Docker daemons cannot mount protected operator configuration.' ;; esac
[ -z "${DOCKER_CONTEXT:-}" ] || die 'select a local Docker context as the default; DOCKER_CONTEXT overrides are refused.'
endpoint=$(docker_call context inspect --format '{{(index .Endpoints "docker").Host}}' 2>/dev/null) || die 'the default Docker context is unavailable.'
case "$endpoint" in unix://*) ;; *) die 'the default Docker context must use a local Unix socket.' ;; esac
daemon_platform=$(docker_call info --format '{{.OSType}}/{{.Architecture}}' 2>/dev/null) || die 'the local Docker daemon is unavailable.'
case "$daemon_platform" in linux/amd64|linux/x86_64) platform=linux/amd64 ;; linux/arm64|linux/aarch64) platform=linux/arm64 ;; *) die 'Docker must run Linux amd64 or arm64 containers.' ;; esac

cfg() {
  mode=$1; shift
  set -- "$mode" --bundle /bundle --config-dir /config --platform "$platform" "$@"
  if [ -n "$target_bundle" ]; then set -- "$@" --target-bundle /target; fi
  if [ -n "$answers_file" ]; then set -- "$@" --answers-file /answers.json; fi
  if [ -n "$target_env" ]; then set -- "$@" --target-env-file /restore.env; fi
  # Setup prompts retain a TTY; all other calls remain noninteractive.
  tty_args=
  network_args=
  if [ "$mode" = recovery-execute ]; then network_args="--network host"; fi
  if [ "$mode" = setup ] && [ -z "$answers_file" ]; then tty_args=-it; fi
  if [ -n "$target_bundle" ] && [ -n "$target_env" ]; then die 'target bundle and restore config cannot be combined.'; fi
  if [ -n "$target_bundle" ]; then
    docker_call run --rm ${network_args:+$network_args} ${tty_args:+$tty_args} --read-only --tmpfs /tmp --user "$(id -u):$(id -g)" --mount "type=bind,source=$bundle,target=/bundle,readonly" --mount "type=bind,source=$config_dir,target=/config" --mount "type=bind,source=$target_bundle,target=/target,readonly" "$ops_image" node /app/deploy/self-host/configure.mjs "$@" 2>/dev/null
  elif [ -n "$answers_file" ]; then
    docker_call run --rm ${network_args:+$network_args} ${tty_args:+$tty_args} --read-only --tmpfs /tmp --user "$(id -u):$(id -g)" --mount "type=bind,source=$bundle,target=/bundle,readonly" --mount "type=bind,source=$config_dir,target=/config" --mount "type=bind,source=$answers_file,target=/answers.json,readonly" "$ops_image" node /app/deploy/self-host/configure.mjs "$@" 2>/dev/null
  elif [ -n "$target_env" ]; then
    docker_call run --rm ${network_args:+$network_args} ${tty_args:+$tty_args} --read-only --tmpfs /tmp --user "$(id -u):$(id -g)" --mount "type=bind,source=$bundle,target=/bundle,readonly" --mount "type=bind,source=$config_dir,target=/config" --mount "type=bind,source=$target_env,target=/restore.env,readonly" "$ops_image" node /app/deploy/self-host/configure.mjs "$@" 2>/dev/null
  else
    docker_call run --rm ${network_args:+$network_args} ${tty_args:+$tty_args} --read-only --tmpfs /tmp --user "$(id -u):$(id -g)" --mount "type=bind,source=$bundle,target=/bundle,readonly" --mount "type=bind,source=$config_dir,target=/config" "$ops_image" node /app/deploy/self-host/configure.mjs "$@" 2>/dev/null
  fi
}

lock_owned=false; upgrade_owned=false; phase=validate; report_file=; observations_file=
cleanup() {
  code=$?
  if [ "$lock_owned" = true ]; then
    if [ "$upgrade_owned" = true ] && [ "$code" -ne 0 ]; then cfg receipt --status failed --phase "$phase" >/dev/null 2>&1 || printf '%s\n' 'Upgrade failed; receipt write could not be confirmed. Preserve the protected config and completed backup.' >&2; fi
    rmdir -- "$config_dir/operation.lock" || printf '%s\n' 'Operation lock remains; inspect it before another mutation.' >&2
  fi
  [ -z "$report_file" ] || rm -f -- "$report_file"
  [ -z "$observations_file" ] || rm -f -- "$observations_file"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# One lock fences every operation that can start writers or change managed state.
case "$command:$action" in
  setup:|up:|bootstrap:|upgrade:|backup:config|backup:execute|recover:execute)
    mkdir -m 700 -- "$config_dir/operation.lock" 2>/dev/null || die 'another operation holds the lock; a stale lock requires operator inspection.'
    lock_owned=true ;;
esac

if [ "$command" = setup ]; then cfg setup || die 'setup rejected; use protected inputs, HTTPS, explicit SMTP/Resend and a fresh mode-0700 directory. Existing credentials are never overwritten.'; exit 0; fi
metadata=$(cfg metadata) || die 'protected configuration or active bundle validation failed; use the exact target bundle after forward migration.'
project=$(printf '%s\n' "$metadata" | sed -n 1p)
mcp=$(printf '%s\n' "$metadata" | sed -n 2p)
printf '%s\n' "$project" | LC_ALL=C grep -Eq '^[a-z][a-z0-9-]{0,48}$' || die 'invalid protected Compose project name.'
[ "$mcp" = true ] || [ "$mcp" = false ] || die 'invalid MCP opt-in.'
compose_dir=$bundle
compose() {
  env -i PATH="$PATH" HOME="${HOME:-}" DOCKER_CONFIG="$docker_config" MYSKILLS_CONFIG_DIR="$config_dir" MYSKILLS_BOOTSTRAP_ENV_FILE="$config_dir/bootstrap.env" MYSKILLS_BACKUP_ENV_FILE="$config_dir/backup.env" \
    docker compose --project-name "$project" --file "$compose_dir/compose.yml" --env-file "$compose_dir/release.env" --env-file "$config_dir/runtime.env" "$@"
}
quiet_compose() { compose "$@" >/dev/null 2>&1 || die 'Compose operation failed; raw provider output is withheld. Use status and the operator runbook.'; }
fresh_report() { report_file=$(mktemp "$config_dir/operator-report.XXXXXXXX"); chmod 600 "$report_file"; }
backup_run() {
  cfg backup-config >/dev/null || die 'protected external backup configuration is required.'
  fresh_report
  backup_result=0
  compose --profile operations run --rm --no-deps ops node scripts/run-registry-backup.mjs "$1" >"$report_file" 2>/dev/null || backup_result=$?
  if [ "$upgrade_owned" = true ]; then
    cfg backup-report --report-file "/config/$(basename "$report_file")" --attach-upgrade-receipt true || backup_result=1
  else
    cfg backup-report --report-file "/config/$(basename "$report_file")" || backup_result=1
  fi
  rm -f -- "$report_file"; report_file=
  [ "$backup_result" -eq 0 ] || die 'coordinated backup did not complete successfully; no migration should proceed.'
}
backup_identity() {
  identity=$(compose exec -T postgres sh -ec 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT value #>> '\''{}'\'' FROM public.instance_settings WHERE key = '\''instance_id'\''"' 2>/dev/null) || die 'could not read the migrated instance identity; run up first and inspect database readiness.'
  printf '%s\n' "$identity" | LC_ALL=C grep -Eq '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' || die 'the migrated database instance identity is missing or invalid.'
  cfg backup-config --instance-id "$identity" || die 'backup.env must use the exact database instance_id as MYSKILLS_BACKUP_INSTANCE_ID.'
}
check_running_images() {
  for service in api web; do
    container=$(compose ps -q "$service" 2>/dev/null) || die 'could not inspect the current application containers.'
    printf '%s\n' "$container" | LC_ALL=C grep -Eq '^[a-f0-9]{12,64}$' || die 'current application containers are absent or ambiguous; upgrade requires a running verified source.'
    actual=$(docker_call inspect --format '{{.Config.Image}}' "$container" 2>/dev/null) || die 'could not inspect the current application image.'
    key=$(printf '%s' "$service" | tr '[:lower:]' '[:upper:]')
    expected=$(sed -n "s/^MYSKILLS_${key}_IMAGE=//p" "$bundle/release.env")
    [ "$actual" = "$expected" ] || die 'running image differs from the source bundle; resolve drift before upgrading.'
  done
}

case "$command" in
  preflight) docker_call compose version >/dev/null 2>&1 || die 'Docker Compose v2 is unavailable.'; cfg validate ;;
  up)
    cfg startup-check || die 'forward migration requires the exact target bundle for startup; preserve the barrier and use isolated recovery if needed.'
    quiet_compose pull postgres minio minio-init migrate api web
    quiet_compose up -d --wait postgres minio
    quiet_compose run --rm --no-deps minio-init
    quiet_compose run --rm --no-deps migrate
    quiet_compose up -d --wait --no-deps api
    if [ "$mcp" = true ]; then quiet_compose --profile mcp pull mcp-http; quiet_compose --profile mcp up -d --wait --no-deps mcp-http; fi
    quiet_compose up -d --wait --no-deps web
    cfg resume-active
    printf '%s\n' 'Compose startup completed with service health checks. Verify HTTPS, email, owner/MFA and real client workflows before reporting a live deployment.' ;;
  bootstrap)
    cfg startup-check || die 'forward migration requires the exact target bundle for startup; preserve the barrier and use isolated recovery if needed.'
    # The API command itself enforces fresh-only, atomic and credential-preserving retries.
    quiet_compose --profile bootstrap run --rm --no-deps bootstrap
    printf '%s\n' 'Fresh-only owner bootstrap command completed. Verify owner sign-in and MFA through HTTPS.' ;;
  backup) case "$action" in config) backup_identity ;; status) backup_run --status ;; execute) backup_identity; backup_run --execute ;; esac ;;
  diagnostics) quiet_compose ps; cfg validate; printf '%s\n' 'Safe diagnostics passed. Raw logs and environment dumps are withheld.' ;;
  status)
    observations_file=$(mktemp "$config_dir/operator-observations.XXXXXXXX"); chmod 600 "$observations_file"
    for name in api web mcp minio postgres; do
      service=$name; [ "$name" != mcp ] || service=mcp-http
      [ "$name" != mcp ] || [ "$mcp" = true ] || continue
      container=$(compose --profile mcp ps -q "$service" 2>/dev/null) || container=
      if printf '%s\n' "$container" | LC_ALL=C grep -Eq '^[a-f0-9]{12,64}$'; then
        observation=$(docker_call inspect --format '{{.Config.Image}} {{if .State.Health}}{{.State.Health.Status}}{{else}}unavailable{{end}}' "$container" 2>/dev/null) || observation=
        if printf '%s\n' "$observation" | LC_ALL=C grep -Eq '^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64} (healthy|unhealthy|unavailable)$'; then printf '%s %s\n' "$name" "$observation" >>"$observations_file"; fi
      fi
    done
    backup_state=not-configured
    if [ -e "$config_dir/backup.env" ]; then
      backup_state=error
      if cfg backup-config >/dev/null 2>&1; then fresh_report; compose --profile operations run --rm --no-deps ops node scripts/run-registry-backup.mjs --status >"$report_file" 2>/dev/null || :; fi
    fi
    if [ -n "$report_file" ]; then cfg status --observations-file "/config/$(basename "$observations_file")" --backup-state "$backup_state" --report-file "/config/$(basename "$report_file")";
    else cfg status --observations-file "/config/$(basename "$observations_file")" --backup-state "$backup_state"; fi
    if [ "$json" != true ]; then printf '%s\n' 'This receipt records source, observed images/health and backup freshness. It does not prove publisher authenticity, restored authentication or public HTTPS behavior.'; fi ;;
  upgrade)
    cfg startup-check || die 'forward migration requires the exact target bundle for startup; preserve the barrier and use isolated recovery if needed.'
    cfg upgrade-check
    check_running_images
    upgrade_owned=true
    cfg receipt --status in-progress --phase validate
    compose_dir=$target_bundle; phase=pull-target; cfg receipt --status in-progress --phase "$phase"
    quiet_compose pull postgres minio minio-init migrate api web
    if [ "$mcp" = true ]; then quiet_compose --profile mcp pull mcp-http; fi
    phase=stop-app-writes; cfg receipt --status in-progress --phase "$phase"
    compose_dir=$bundle; quiet_compose --profile mcp stop api web mcp-http
    phase=backup-current; cfg receipt --status in-progress --phase "$phase"; backup_identity; backup_run --execute
    phase=migrate-target; cfg receipt --status in-progress --phase "$phase"; compose_dir=$target_bundle
    cfg migration-barrier
    quiet_compose run --rm --no-deps migrate
    phase=ready-api; cfg receipt --status in-progress --phase "$phase"; quiet_compose up -d --wait --no-deps api
    if [ "$mcp" = true ]; then quiet_compose --profile mcp up -d --wait --no-deps mcp-http; fi
    phase=ready-web; cfg receipt --status in-progress --phase "$phase"; quiet_compose up -d --wait --no-deps web
    phase=complete; cfg receipt --status passed --phase "$phase"; cfg record-active
    printf '%s\n' 'Forward upgrade completed with service health checks. Use the target bundle helper and verify HTTPS, owner/MFA, source-backed skills and client workflows.' ;;
  recover)
    if [ "$action" = plan ]; then
      printf '%s\n' 'Restore only to new empty loopback PostgreSQL and object bucket destinations from a completed coordinated backup.' \
        'Prepare protected backup.env and --target-env-file restore.env. Execution uses the existing guarded restore, with no in-place destruction or automatic downgrade.' \
        'Execution is Linux-only with a local Docker daemon and --network host. On other hosts, use a separate Linux recovery host; do not run an automatic restore here.' \
        'After restore, verify rows/artifacts, owner sign-in/MFA/revocation/audit state and real client workflows before switching HTTPS traffic.'
    else
      [ "$(uname -s)" = Linux ] || die 'recovery execution requires Linux host networking; use recover plan and a separate Linux recovery host.'
      [ -n "$target_env" ] || die 'explicit recovery requires a protected target environment file.'
      cfg recovery-check --run-id "$run_id"
      # Execute the same parsed values as preflight. Docker --env-file does not
      # interpret the quoting accepted by the protected configuration parser.
      cfg recovery-execute --run-id "$run_id" || die 'guarded restore failed; preserve protected recovery evidence and inspect the recovery runbook.'
      printf '%s\n' 'Guarded isolated restore completed. Verify protected evidence and owner/MFA/revocation/auth behavior before switching traffic.'
    fi ;;
esac
