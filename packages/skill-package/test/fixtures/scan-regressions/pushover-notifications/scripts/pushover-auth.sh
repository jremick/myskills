#!/usr/bin/env bash
set -euo pipefail

APP_NAME="Pushover Notifications"
AUTH_MODE="keychain-user"
APP_TOKEN_ENV_VAR="PUSHOVER_APP_TOKEN"
USER_KEY_ENV_VAR="PUSHOVER_USER_KEY"
DEVICE_ENV_VAR="PUSHOVER_DEVICE"
OP_ACCOUNT="${PUSHOVER_OP_ACCOUNT:-example.1password.com}"
OP_VAULT="${PUSHOVER_OP_VAULT:-}"
OP_ITEM="${PUSHOVER_OP_ITEM:-Pushover}"
OP_APP_TOKEN_FIELD="${PUSHOVER_OP_APP_TOKEN_FIELD:-pushover codex app key}"
OP_USER_KEY_FIELD="${PUSHOVER_OP_USER_KEY_FIELD:-pushover user key}"
OP_DEVICE_FIELD="${PUSHOVER_OP_DEVICE_FIELD:-}"
KEYCHAIN_SERVICE="codex-pushover-notifications"

die() {
  echo "error: $*" >&2
  exit 1
}

have_command() {
  command -v "$1" >/dev/null 2>&1
}

keychain_available() {
  have_command security
}

op_available() {
  have_command op
}

keychain_read_password() {
  local account=$1
  keychain_available || return 1
  security find-generic-password \
    -a "${account}" \
    -s "${KEYCHAIN_SERVICE}" \
    -w 2>/dev/null
}

keychain_has_password() {
  local account=$1
  keychain_read_password "${account}" >/dev/null 2>&1
}

keychain_store_password() {
  local account=$1
  local password=$2
  keychain_available || die "macOS security CLI is required for keychain storage"
  security add-generic-password \
    -U \
    -a "${account}" \
    -s "${KEYCHAIN_SERVICE}" \
    -l "${KEYCHAIN_SERVICE}:${account}" \
    -w "${password}" >/dev/null
}

keychain_delete_password() {
  local account=$1
  keychain_available || die "macOS security CLI is required for keychain storage"
  security delete-generic-password \
    -a "${account}" \
    -s "${KEYCHAIN_SERVICE}" >/dev/null 2>&1 || true
}

env_is_set() {
  local name=$1
  [[ -n "${!name:-}" ]]
}

source_for() {
  local env_var=$1
  local account=$2

  if env_is_set "${env_var}"; then
    printf "%s\n" "env"
    return
  fi

  if keychain_has_password "${account}"; then
    printf "%s\n" "keychain"
    return
  fi

  printf "%s\n" "missing"
}

read_secret_value() {
  local env_var=$1
  local account=$2
  local label=$3

  if env_is_set "${env_var}"; then
    printf "%s" "${!env_var}"
    return
  fi

  if keychain_has_password "${account}"; then
    keychain_read_password "${account}"
    return
  fi

  die "missing ${label}; run 'scripts/pushover-auth.sh configure' or provide ${env_var}"
}

read_app_token_cmd() {
  read_secret_value "${APP_TOKEN_ENV_VAR}" "app-token" "Pushover app token"
}

read_user_key_cmd() {
  read_secret_value "${USER_KEY_ENV_VAR}" "user-key" "Pushover user key"
}

read_device_cmd() {
  if env_is_set "${DEVICE_ENV_VAR}"; then
    printf "%s" "${!DEVICE_ENV_VAR}"
    return
  fi

  if keychain_has_password "device"; then
    keychain_read_password "device"
  fi
}

read_hidden() {
  local prompt=$1
  local value
  printf "%s" "${prompt}" >&2
  IFS= read -rs value
  printf "\n" >&2
  printf "%s" "${value}"
}

read_visible() {
  local prompt=$1
  local value
  printf "%s" "${prompt}" >&2
  IFS= read -r value
  printf "%s" "${value}"
}

configure_cmd() {
  local app_token
  local user_key
  local device

  app_token=$(read_hidden "Pushover application/API token: ")
  [[ -n "${app_token}" ]] || die "app token cannot be empty"

  user_key=$(read_hidden "Pushover user/group key: ")
  [[ -n "${user_key}" ]] || die "user key cannot be empty"

  device=$(read_visible "Optional Pushover device name, blank for all active devices: ")

  keychain_store_password "app-token" "${app_token}"
  keychain_store_password "user-key" "${user_key}"

  if [[ -n "${device}" ]]; then
    keychain_store_password "device" "${device}"
  else
    keychain_delete_password "device"
  fi

  echo "stored Pushover credentials in macOS Keychain service ${KEYCHAIN_SERVICE}"
}

op_field() {
  local field=$1
  op_available || die "1Password CLI 'op' is required"

  if [[ -n "${OP_VAULT}" ]]; then
    OP_ACCOUNT="${OP_ACCOUNT}" \
      op item get "${OP_ITEM}" --vault "${OP_VAULT}" --reveal --fields "label=${field}"
    return
  fi

  OP_ACCOUNT="${OP_ACCOUNT}" \
    op item get "${OP_ITEM}" --reveal --fields "label=${field}"
}

import_cmd() {
  local app_token
  local user_key
  local device

  app_token=$(op_field "${OP_APP_TOKEN_FIELD}")
  [[ -n "${app_token}" ]] || die "failed to read Pushover app token from 1Password"

  user_key=$(op_field "${OP_USER_KEY_FIELD}")
  [[ -n "${user_key}" ]] || die "failed to read Pushover user key from 1Password"

  keychain_store_password "app-token" "${app_token}"
  keychain_store_password "user-key" "${user_key}"

  if [[ -n "${OP_DEVICE_FIELD}" ]] && device=$(op_field "${OP_DEVICE_FIELD}" 2>/dev/null) && [[ -n "${device}" ]]; then
    keychain_store_password "device" "${device}"
  fi

  echo "stored Pushover credentials from 1Password into macOS Keychain service ${KEYCHAIN_SERVICE}"
}

delete_keychain_cmd() {
  keychain_delete_password "app-token"
  keychain_delete_password "user-key"
  keychain_delete_password "device"
  echo "deleted Pushover entries from macOS Keychain service ${KEYCHAIN_SERVICE}"
}

status_cmd() {
  local mode=${1:-text}
  local app_source
  local user_source
  local device_source
  app_source=$(source_for "${APP_TOKEN_ENV_VAR}" "app-token")
  user_source=$(source_for "${USER_KEY_ENV_VAR}" "user-key")
  device_source=$(source_for "${DEVICE_ENV_VAR}" "device")

  if [[ "${mode}" == "--json" ]]; then
    python3 - "${APP_NAME}" "${AUTH_MODE}" "${APP_TOKEN_ENV_VAR}" "${USER_KEY_ENV_VAR}" "${DEVICE_ENV_VAR}" "${KEYCHAIN_SERVICE}" "${OP_ACCOUNT}" "${OP_VAULT}" "${OP_ITEM}" "${OP_APP_TOKEN_FIELD}" "${OP_USER_KEY_FIELD}" "${OP_DEVICE_FIELD}" "${app_source}" "${user_source}" "${device_source}" <<'PY'
import json
import sys

(
    app_name,
    auth_mode,
    app_token_env,
    user_key_env,
    device_env,
    keychain_service,
    op_account,
    op_vault,
    op_item,
    op_app_token_field,
    op_user_key_field,
    op_device_field,
    app_token_source,
    user_key_source,
    device_source,
) = sys.argv[1:]

print(json.dumps({
    "appName": app_name,
    "authMode": auth_mode,
    "envVars": {
        "appToken": app_token_env,
        "userKey": user_key_env,
        "device": device_env,
    },
    "keychain": {
        "service": keychain_service,
        "accounts": ["app-token", "user-key", "device"],
    },
    "onePassword": {
        "account": op_account,
        "vault": op_vault or None,
        "item": op_item,
        "fields": {
            "appToken": op_app_token_field,
            "userKey": op_user_key_field,
            "device": op_device_field,
        },
    },
    "sources": {
        "appToken": app_token_source,
        "userKey": user_key_source,
        "device": device_source,
    },
    "readyToSend": app_token_source != "missing" and user_key_source != "missing",
}, indent=2))
PY
    return
  fi

  cat <<EOF
app: ${APP_NAME}
auth mode: ${AUTH_MODE}
app token source: ${app_source}
user key source: ${user_source}
device source: ${device_source}
keychain service: ${KEYCHAIN_SERVICE}
ready to send: $([[ "${app_source}" != "missing" && "${user_source}" != "missing" ]] && echo yes || echo no)
EOF
}

case "${1:-}" in
  status)
    shift || true
    status_cmd "${1:-text}"
    ;;
  configure)
    configure_cmd
    ;;
  import-from-1password)
    import_cmd
    ;;
  delete-keychain-credentials)
    delete_keychain_cmd
    ;;
  read-app-token)
    read_app_token_cmd
    ;;
  read-user-key)
    read_user_key_cmd
    ;;
  read-device)
    read_device_cmd
    ;;
  *)
    die "unknown command '${1:-}'"
    ;;
esac
