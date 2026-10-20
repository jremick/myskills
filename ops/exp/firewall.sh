#!/bin/bash
# Phase 0: interface-scoped rules only. No credentials belong on /boot.
set -euo pipefail
APP=myskills
BRIDGES=(br-myskills br-myskills-db)
log() { printf '%s %s: %s\n' "$(date -Iseconds)" "$APP" "$*"; }
rules() {
  local b cidr source proto port
  for b in "${BRIDGES[@]}"; do
    echo "iptables INPUT -i $b -m conntrack --ctstate NEW -j DROP"
    echo "iptables DOCKER-USER -i $b -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN"
    echo "iptables DOCKER-USER -i $b -o $b -j RETURN"
    for cidr in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16 224.0.0.0/4 0.0.0.0/8; do
      echo "iptables DOCKER-USER -i $b -d $cidr -j DROP"
    done
    while read -r source proto port; do
      test -n "$source" || continue
      echo "iptables DOCKER-USER -i $b -s $source/32 -p $proto --dport $port -j ACCEPT"
    done < <(allowlist "$b")
    echo "iptables DOCKER-USER -i $b -j DROP"
    echo "iptables DOCKER-USER -o $b ! -i $b -m conntrack --ctstate NEW -j DROP"
    echo "ip6tables INPUT -i $b -j DROP"
    echo "ip6tables DOCKER-USER -i $b -j DROP"
    echo "ip6tables DOCKER-USER -o $b -j DROP"
  done
}
allowlist() {
  if test "$1" = br-myskills; then
    printf '%s\n' '172.30.40.2 tcp 7844' '172.30.40.2 udp 7844' '172.30.40.2 tcp 443' '172.30.40.4 tcp 443' '172.30.40.5 tcp 443'
  fi
}
canonical_rules() {
  awk '{
    iif=oif=src=dst=proto=state=port=target=""; inverse=""
    for(k=1;k<=NF;k++) {
      if($k=="!" && $(k+1)=="-i") inverse="!"
      if($k=="-i") iif=$(k+1)
      if($k=="-o") oif=$(k+1)
      if($k=="-s") src=$(k+1)
      if($k=="-d") dst=$(k+1)
      if($k=="-p") proto=$(k+1)
      if($k=="--ctstate") state=$(k+1)
      if($k=="--dport") port=$(k+1)
      if($k=="-j") target=$(k+1)
    }
    if(state=="RELATED,ESTABLISHED") state="ESTABLISHED,RELATED"
    if($0=="EARLY_UNSCOPED_RETURN") {print; next}
    print inverse iif "|" oif "|" src "|" dst "|" proto "|" state "|" port "|" target
  }'
}
verify() {
  local tool chain rest line actual expected; local -a args
  while read -r tool chain rest; do
    read -r -a args <<< "$rest"
    "$tool" -w 5 -C "$chain" "${args[@]}" 2>/dev/null || { log "missing rule: $tool $chain $rest"; return 1; }
  done < <(rules)
  # Scoped blocks must precede every unscoped rule that could bypass them.
  for tool in iptables ip6tables; do
    for chain in INPUT DOCKER-USER; do
      expected=$(rules | awk -v t="$tool" -v c="$chain" '$1==t && $2==c {sub(/^[^ ]+ [^ ]+ /,"-A " c " "); print}' | canonical_rules)
      actual=$("$tool" -S "$chain" | awk -v names="${BRIDGES[*]}" -v marker="$APP-maintenance" '
        BEGIN {n=split(names,b," "); split("br-myskills br-myskills-db br-forgetbase br-fb-db br-fb-fc br-fb-scan",all," "); for(i in all) known[all[i]]=1}
        !/^-A / {next}
        index($0,marker) {next}
        {
          own=0; safe=0
          for(i=1;i<=n;i++) for(j=1;j<=NF;j++) if($j==b[i]) own=1
          if(own) {if(barrier) print "EARLY_UNSCOPED_RETURN"; print; next}
          # The other app has exact positive input-interface matches or DROP.
          for(j=1;j<=NF;j++) {
            if($j=="-i" && $(j-1)!="!" && known[$(j+1)]) safe=1
            if($j=="-j" && $(j+1)=="DROP") safe=1
          }
          if(!safe) barrier=1
        }
      ' | canonical_rules)
      test "$expected" = "$actual" || { log "$tool $chain scoped rule order is invalid"; return 1; }
    done
  done
}
stop_tunnel() {
  if docker container inspect "$APP-tunnel" >/dev/null 2>&1; then
    timeout 5 docker stop --time 1 "$APP-tunnel" >/dev/null || { log 'tunnel stop failed; watchdog will retry'; return 1; }
    log 'tunnel stopped'
  fi
}
start_tunnel() {
  timeout 35 /bin/bash "$0" verify || { stop_tunnel || true; log 'refusing tunnel start: firewall verification failed'; return 1; }
  local envfile="/mnt/cache/appdata/$APP/secrets/tunnel.env"
  if ! test -f "$envfile"; then log 'tunnel.env absent; tunnel start skipped'; return 0; fi
  test "$(stat -c '%a:%u' "$envfile")" = '600:0' || { log 'unsafe tunnel.env mode/owner'; return 1; }
  # run-tunnel.sh also verifies rules and is always --restart no.
  /bin/bash "/mnt/cache/appdata/$APP/bin/run-tunnel.sh" start-verified
}
maintenance_guards() {
  local operation="$1" tool b chain direction; local -a args
  for tool in iptables ip6tables; do
    for b in "${BRIDGES[@]}"; do
      for spec in 'INPUT -i' 'FORWARD -i' 'FORWARD -o'; do
        read -r chain direction <<< "$spec"
        args=("$direction" "$b" -m comment --comment "$APP-maintenance" -j DROP)
        case "$operation" in
          add) "$tool" -w 5 -C "$chain" "${args[@]}" 2>/dev/null || "$tool" -w 5 -I "$chain" 1 "${args[@]}";;
          verify) "$tool" -w 5 -C "$chain" "${args[@]}";;
          remove) "$tool" -w 5 -D "$chain" "${args[@]}";;
        esac
      done
    done
  done
}
apply() {
  stop_tunnel
  # Host FORWARD guards precede Docker dispatch throughout rule replacement.
  maintenance_guards add
  maintenance_guards verify
  local tool chain rest; local -a args lines
  mapfile -t lines < <(rules)
  for line in "${lines[@]}"; do
    read -r tool chain rest <<< "$line"; read -r -a args <<< "$rest"
    while "$tool" -w 5 -C "$chain" "${args[@]}" 2>/dev/null; do "$tool" -w 5 -D "$chain" "${args[@]}"; done
  done
  for ((i=${#lines[@]}-1;i>=0;i--)); do
    read -r tool chain rest <<< "${lines[i]}"; read -r -a args <<< "$rest"
    "$tool" -w 5 -I "$chain" 1 "${args[@]}"
  done
  verify
  maintenance_guards remove
  verify
  log 'all rules installed and verified'
}
case "${1:-apply}" in
  rules) rules;;
  verify) verify;;
  watchdog)
    exec 8>"/run/$APP-watchdog.lock"; flock -n 8 || exit 0
    # Ten-second polling leaves time to stop within the required 60 seconds.
    while :; do
      if ! timeout 35 /bin/bash "$0" verify; then stop_tunnel || true; fi
      sleep 10
    done;;
  start)
    exec 9>"/run/$APP-firewall.lock"; flock 9; start_tunnel;;
  apply)
    exec 9>"/run/$APP-firewall.lock"; flock 9
    apply
    nohup /bin/bash "$0" watchdog 9>&- >>"/var/log/$APP-fw.log" 2>&1 </dev/null &
    start_tunnel;;
  *) echo 'usage: firewall.sh {apply|verify|start|watchdog|rules}' >&2; exit 2;;
esac
