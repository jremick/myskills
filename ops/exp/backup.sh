#!/usr/bin/env bash
# Run only after the prerequisites in BACKUPS.md have been verified.
set +x
set -euo pipefail
umask 077
app=myskills
fail() { printf '%s backup failed: %s\n' "$app" "$1" >&2; exit 1; }
required() { [[ -n "${!1:-}" ]] || fail "missing $1"; }

# Check deferred configuration before reading any application data.
for name in AGE_RECIPIENT R2_BACKUP_BUCKET RCLONE_CONFIG_R2_TYPE \
  RCLONE_CONFIG_R2_PROVIDER RCLONE_CONFIG_R2_ACCESS_KEY_ID \
  RCLONE_CONFIG_R2_SECRET_ACCESS_KEY RCLONE_CONFIG_R2_ENDPOINT \
  BACKUP_R2_PROTECTION_CONFIRMED PGHOST PGPORT PGDATABASE PGUSER PGPASSWORD; do
  required "$name"
done
[[ "$R2_BACKUP_BUCKET" == "$app-backups" ]] || fail 'unexpected backup bucket'
[[ "$RCLONE_CONFIG_R2_TYPE" == s3 && "$RCLONE_CONFIG_R2_PROVIDER" == Cloudflare ]] || fail 'unexpected R2 backend'
[[ "$RCLONE_CONFIG_R2_ENDPOINT" =~ ^https://[a-z0-9-]+\.r2\.cloudflarestorage\.com$ ]] || fail 'R2 endpoint must use HTTPS'
[[ "$AGE_RECIPIENT" =~ ^age1[0-9a-z]+$ ]] || fail 'a native age public recipient is required'
[[ "$BACKUP_R2_PROTECTION_CONFIRMED" == 35-day-lock-and-lifecycle ]] || fail 'bucket lock and lifecycle are not confirmed'
[[ "$PGHOST" == myskills-postgres && "$PGDATABASE" == "$app" && "$PGPORT" == 5432 ]] || fail 'unexpected source database'
[[ "$PGUSER" == "${app}_app" ]] || fail 'backup must use the DML role'

for tool in pg_dump age rclone sha256sum mkfifo tee mktemp date; do
  command -v "$tool" >/dev/null 2>&1 || fail "missing executable $tool"
done
unset PGHOSTADDR PGSERVICE PGSERVICEFILE
export PGCONNECT_TIMEOUT=10 PGAPPNAME="${app}-encrypted-backup"
export RCLONE_CONFIG_R2_ENV_AUTH=false RCLONE_CONFIG_R2_REGION=auto
export RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true
remote() { rclone --config /dev/null --log-level ERROR --stats 0 --retries 1 "$@" 2>/dev/null; }

# Only FIFOs, ciphertext digests, and completion metadata use /tmp.
# Root-owned /backups stays mode 700 and is not accessed by this nonroot process.
work="$(mktemp -d "/tmp/${app}-backup.XXXXXX")"
hash_pid=''
cleanup() {
  if [[ -n "$hash_pid" ]]; then kill "$hash_pid" 2>/dev/null || true; wait "$hash_pid" 2>/dev/null || true; fi
  rm -rf -- "$work"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
run_id="$(date -u +%Y%m%dT%H%M%SZ)-${work##*.}"
prefix="r2:${R2_BACKUP_BUCKET}/daily/${run_id}"
manifest="$work/complete.sha256"
: > "$manifest"

upload_encrypted() {
  local name="$1" digest remote_digest
  shift
  mkfifo "$work/ciphertext"
  sha256sum < "$work/ciphertext" > "$work/digest" &
  hash_pid=$!
  if ! "$@" 2>/dev/null | age -r "$AGE_RECIPIENT" 2>/dev/null | \
      tee "$work/ciphertext" | remote rcat "$prefix/$name"; then
    fail "stream failed for $name; this backup has no completion marker"
  fi
  wait "$hash_pid" || fail 'ciphertext hashing failed'
  hash_pid=''
  rm -- "$work/ciphertext"
  read -r digest _ < "$work/digest"
  remote_digest="$(remote cat "$prefix/$name" | sha256sum)" || fail 'uploaded ciphertext readback failed'
  [[ "${remote_digest%% *}" == "$digest" ]] || fail 'uploaded ciphertext checksum mismatch'
  printf '%s  %s\n' "$digest" "$name" >> "$manifest"
}

upload_encrypted database.dump.age pg_dump --format=custom --no-password

remote copyto "$manifest" "$prefix/complete.sha256" --immutable || fail 'completion marker upload failed'
# Sunday UTC keeps a weekly recovery point without a second plaintext read.
if [[ "$(date -u +%u)" == 7 ]]; then
  weekly="r2:${R2_BACKUP_BUCKET}/weekly/${run_id}"
  while read -r expected_digest name; do
    remote copyto "$prefix/$name" "$weekly/$name" --immutable || fail 'weekly ciphertext copy failed'
    weekly_digest="$(remote cat "$weekly/$name" | sha256sum)" || fail 'weekly ciphertext readback failed'
    [[ "${weekly_digest%% *}" == "$expected_digest" ]] || fail 'weekly ciphertext checksum mismatch'
  done < "$manifest"
  remote copyto "$manifest" "$weekly/complete.sha256" --immutable || fail 'weekly completion marker upload failed'
fi
printf '%s encrypted backup complete: %s\n' "$app" "$run_id"
