#!/usr/bin/env bash
# Portable CI and release-check entrypoint. The contract is in docs/LOCAL_CI.md.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
node_bin=""
for candidate in "${LOCAL_CI_NODE22_BIN:-}" "${LOCAL_CI_NODE24_BIN:-}"; do
  if [ -n "$candidate" ] && [ -x "$candidate/node" ]; then
    node_bin="$candidate/node"
    break
  fi
done
if [ -z "$node_bin" ]; then
  node_bin="$(command -v node || true)"
fi
if [ -z "$node_bin" ]; then
  echo "local-ci: node was not found. Set LOCAL_CI_NODE22_BIN or LOCAL_CI_NODE24_BIN, or put node on PATH." >&2
  exit 2
fi

# exec keeps the orchestrator as the signalled process so cancellation cleans up.
exec "$node_bin" "$script_dir/local-ci.mjs" "$@"
