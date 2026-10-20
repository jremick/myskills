#!/bin/bash
set -uo pipefail
BRIDGES=(br-myskills br-myskills-db br-forgetbase br-fb-db br-fb-fc br-fb-scan br-fb-bk)
exec 8>/run/railway-exit-watchdog.lock
flock -n 8 || exit 0
alerted=false
while :; do
  failure=
  for bridge in "${BRIDGES[@]}"; do
    if ! ip link show "$bridge" >/dev/null 2>&1; then failure="missing bridge: $bridge"; break; fi
  done
  if [[ -z "$failure" ]] && ! timeout 35 bash /boot/config/myskills-fw.sh verify >/dev/null 2>&1; then
    failure='firewall verification failed'
  fi
  if [[ -n "$failure" ]]; then
    for tunnel in myskills-tunnel forgetbase-tunnel; do
      if docker container inspect "$tunnel" >/dev/null 2>&1; then timeout 5 docker stop --time 1 "$tunnel" >/dev/null 2>&1 || true; fi
    done
    if [[ "$alerted" = false ]]; then
      printf '%s railway-exit FAIL CLOSED: %s; both tunnels stopped or absent\n' "$(date -Iseconds)" "$failure" >> /var/log/railway-exit-fw.log
      if [[ -x /usr/local/emhttp/webGui/scripts/notify ]]; then
        /usr/local/emhttp/webGui/scripts/notify -e 'Railway exit firewall' -s 'Railway exit: tunnels stopped' -d "$failure" -i alert >/dev/null 2>&1
      fi
      alerted=true
    fi
  else
    alerted=false
  fi
  sleep 10
done
