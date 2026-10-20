#!/bin/bash
set -euo pipefail
# Only non-secret immutable image references belong in images.conf.
BIN="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$BIN/images.conf"
ACTION="${1:-create}"
case "$ACTION" in create) COMMAND=(docker create);; run) COMMAND=(docker run -d);; *) echo 'usage: run-<service>.sh {create|run}' >&2; exit 2;; esac
COMMON=(--cap-drop ALL --security-opt no-new-privileges --read-only
  --tmpfs "/tmp:size=${EXP_TMP_SIZE:-64m}" --pids-limit 256 --cpus 1
  --log-opt max-size=10m --log-opt max-file=3)
