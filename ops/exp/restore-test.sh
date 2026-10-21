#!/usr/bin/env bash
# Operates only on a separately provisioned disposable restore environment.
set +x
set -euo pipefail
umask 077
app=myskills
fail() { printf '%s restore test failed: %s\n' "$app" "$1" >&2; exit 1; }
required() { [[ -n "${!1:-}" ]] || fail "missing $1"; }
for name in RESTORE_TEST_CONFIRM RESTORE_DATABASE_FILE RESTORE_DATABASE_SHA256 \
  RESTORE_AGE_IDENTITY_FILE RESTORE_EXPECTED_ROWS RESTORE_READY_URL \
  PGHOST PGPORT PGDATABASE PGUSER PGPASSWORD; do required "$name"; done
[[ "$RESTORE_TEST_CONFIRM" == "${app}-disposable-only" ]] || fail 'disposable restore is not confirmed'
[[ "$PGHOST" == "${app}-restore-postgres" && "$PGPORT" == 5432 ]] || fail 'production or unknown database endpoint refused'
[[ "$PGDATABASE" =~ ^myskills_restore_test_[a-z0-9_]+$ ]] || fail 'disposable database name required'
[[ "$PGUSER" == "${app}_restore" ]] || fail 'dedicated restore role required'
[[ "$RESTORE_DATABASE_FILE" == /restore-input/database.dump.age && -f "$RESTORE_DATABASE_FILE" && ! -L "$RESTORE_DATABASE_FILE" ]] || fail 'encrypted database input missing or unsafe'
[[ "$RESTORE_DATABASE_SHA256" =~ ^[a-f0-9]{64}$ ]] || fail 'database checksum required'
[[ "$RESTORE_AGE_IDENTITY_FILE" == /run/restore-key/identity.txt && -f "$RESTORE_AGE_IDENTITY_FILE" && ! -L "$RESTORE_AGE_IDENTITY_FILE" ]] || fail 'ephemeral identity mount required'
[[ "$RESTORE_READY_URL" =~ ^http://myskills-restore-api:[0-9]+/ready$ ]] || fail 'disposable API readiness URL required'
# Validate every expected count before a database command can run.
IFS=, read -r -a expected_rows <<< "$RESTORE_EXPECTED_ROWS"
[[ "${#expected_rows[@]}" -ge 2 ]] || fail 'at least two table counts are required'
for expected in "${expected_rows[@]}"; do
  [[ "$expected" =~ ^[a-z_][a-z0-9_]*=[0-9]+$ ]] || fail 'unsafe row-count expectation'
done

for tool in age pg_restore psql sha256sum curl stat awk; do
  command -v "$tool" >/dev/null 2>&1 || fail "missing executable $tool"
done
[[ "$(stat -c %a "$RESTORE_AGE_IDENTITY_FILE")" =~ ^(400|600)$ ]] || fail 'identity must have mode 400 or 600'
# /run/restore-key must itself be a read-only tmpfs mount supplied for this test.
awk '$2 == "/run/restore-key" && $3 == "tmpfs" && $4 ~ /(^|,)ro(,|$)/ { ok=1 } END { exit !ok }' /proc/mounts || fail 'identity must be on a read-only tmpfs mount'
export PGCONNECT_TIMEOUT=10 PGAPPNAME="${app}-restore-test"
unset PGHOSTADDR PGSERVICE PGSERVICEFILE
check_hash() {
  local actual
  actual="$(sha256sum "$1")" || fail 'ciphertext checksum read failed'
  [[ "${actual%% *}" == "$2" ]] || fail 'ciphertext checksum mismatch'
}
decrypt() { age --decrypt -i "$RESTORE_AGE_IDENTITY_FILE" "$1" 2>/dev/null; }
query() { psql -X -w -qAt -v ON_ERROR_STOP=1 -c "$1" 2>/dev/null; }
check_hash "$RESTORE_DATABASE_FILE" "$RESTORE_DATABASE_SHA256"
# Check the full archive before writes. Pipefail catches decryption/authentication errors.
decrypt "$RESTORE_DATABASE_FILE" | pg_restore --list >/dev/null 2>&1 || fail 'database archive verification failed'

# A fresh database may contain extension-owned tables, but no application tables.
empty="$(query "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.deptype='e');")" || fail 'target inspection failed'
[[ "$empty" == 0 ]] || fail 'target database is not empty'
decrypt "$RESTORE_DATABASE_FILE" | pg_restore --no-password --exit-on-error \
  --single-transaction --no-owner --no-acl --dbname "$PGDATABASE" >/dev/null 2>&1 || fail 'restore failed; discard the disposable target'
for expected in "${expected_rows[@]}"; do
  table="${expected%%=*}"
  count="$(query "SELECT count(*) FROM public.\"${table}\";")" || fail 'row-count query failed'
  [[ "$count" == "${expected#*=}" ]] || fail 'restored row-count mismatch'
done
# The operator starts the isolated API against this restored DB during this window.
# Do not follow redirects or accept a proxy-generated health page.
ready=false
for attempt in {1..30}; do
  status="$(curl --disable --silent --output /dev/null --write-out '%{http_code}' \
    --connect-timeout 2 --max-time 3 --noproxy '*' "$RESTORE_READY_URL" 2>/dev/null)" || status=000
  if [[ "$status" == 200 ]]; then ready=true; break; fi
  sleep 2
done
[[ "$ready" == true ]] || fail 'restored API readiness check failed'
printf '%s restore test passed: database archive, expected row counts, and isolated API readiness\n' "$app"
