#!/bin/bash
# Phase 0: interface-scoped rules only. No credentials belong on /boot.
set -euo pipefail
APP=myskills
BRIDGES=(br-myskills br-myskills-db br-forgetbase br-fb-db br-fb-fc br-fb-scan br-fb-bk)
CF_FILE=/boot/config/cf-ips-v4.txt
log() { printf '%s %s: %s\n' "$(date -Iseconds)" "$APP" "$*"; }
rules() {
  local b cidr source proto port resolver
  bash /boot/config/cf-ips.sh validate "$CF_FILE" || return 1
  for b in "${BRIDGES[@]}"; do
    echo "iptables INPUT -i $b -m conntrack --ctstate NEW -j DROP"
    echo "iptables DOCKER-USER -i $b -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN"
    echo "iptables DOCKER-USER -i $b -o $b -j RETURN"
    while read -r source; do
      test -n "$source" || continue
      for resolver in 1.1.1.1 1.0.0.1; do
        for proto in udp tcp; do
          echo "iptables DOCKER-USER -i $b -s $source/32 -d $resolver/32 -p $proto --dport 53 -j ACCEPT"
        done
      done
    done < <(dns_sources "$b")
    for cidr in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16 224.0.0.0/4 0.0.0.0/8; do
      echo "iptables DOCKER-USER -i $b -d $cidr -j DROP"
    done
    while read -r source proto port; do
      test -n "$source" || continue
      echo "iptables DOCKER-USER -i $b -s $source/32 -p $proto --dport $port -j ACCEPT"
    done < <(allowlist "$b")
    case "$b" in
      br-myskills) source=172.30.40.5;;
      br-fb-bk) source=172.30.54.2;;
      *) source=;;
    esac
    if test -n "$source"; then
      while read -r cidr; do
        echo "iptables DOCKER-USER -i $b -s $source/32 -d $cidr -p tcp --dport 443 -j ACCEPT"
      done < "$CF_FILE"
    fi
    echo "iptables DOCKER-USER -i $b -j DROP"
    echo "iptables DOCKER-USER -o $b ! -i $b -m conntrack --ctstate NEW -j DROP"
    echo "ip6tables INPUT -i $b -j DROP"
    echo "ip6tables DOCKER-USER -i $b -j DROP"
    echo "ip6tables DOCKER-USER -o $b -j DROP"
  done
  # Host-originated traffic uses OUTPUT, not DOCKER-USER (BK-1 no inbound).
  echo "iptables OUTPUT -o br-myskills -d 172.30.40.5/32 -m conntrack --ctstate NEW -j DROP"
  echo "iptables OUTPUT -o br-fb-bk -d 172.30.54.2/32 -m conntrack --ctstate NEW -j DROP"
}
dns_sources() {
  case "$1" in
    br-myskills) printf '%s\n' 172.30.40.2 172.30.40.4 172.30.40.5;;
    br-forgetbase) echo 172.30.50.2;;
    br-fb-fc) echo 172.30.52.2;;
    br-fb-bk) echo 172.30.54.2;;
  esac
}
allowlist() {
  case "$1" in
    br-myskills) printf '%s\n' '172.30.40.2 tcp 7844' '172.30.40.2 udp 7844' '172.30.40.2 tcp 443' '172.30.40.4 tcp 443';;
    br-forgetbase) printf '%s\n' '172.30.50.2 tcp 7844' '172.30.50.2 udp 7844' '172.30.50.2 tcp 443';;
    br-fb-fc) echo '172.30.52.2 tcp 443';;
  esac
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
  local tool chain rest line actual expected b; local -a args
  for b in "${BRIDGES[@]}"; do
    ip link show "$b" >/dev/null 2>&1 || { log "missing bridge: $b"; return 1; }
  done
  bash /boot/config/cf-ips.sh validate "$CF_FILE" || return 1
  while read -r tool chain rest; do
    read -r -a args <<< "$rest"
    "$tool" -w 5 -C "$chain" "${args[@]}" 2>/dev/null || { log "missing rule: $tool $chain $rest"; return 1; }
  done < <(rules)
  # Scoped blocks must precede every unscoped rule that could bypass them.
  for tool in iptables ip6tables; do
    for chain in INPUT DOCKER-USER; do
      expected=$(rules | awk -v t="$tool" -v c="$chain" '$1==t && $2==c {sub(/^[^ ]+ [^ ]+ /,"-A " c " "); print}' | canonical_rules)
      actual=$("$tool" -S "$chain" | awk -v names="${BRIDGES[*]}" -v marker="railway-exit-maintenance" '
        BEGIN {n=split(names,b," "); split("br-myskills br-myskills-db br-forgetbase br-fb-db br-fb-fc br-fb-scan br-fb-bk",all," "); for(i in all) known[all[i]]=1}
        !/^-A / {next}
        index($0,"railway-exit-maintenance") {next}
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
  local tunnel failed=0
  for tunnel in myskills-tunnel forgetbase-tunnel; do
    if docker container inspect "$tunnel" >/dev/null 2>&1; then
      timeout 5 docker stop --time 1 "$tunnel" >/dev/null || failed=1
      log "$tunnel stop requested"
    fi
  done
  return "$failed"
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
        args=("$direction" "$b" -m comment --comment "railway-exit-maintenance" -j DROP)
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
  local generated
  generated=$(rules)
  mapfile -t lines <<< "$generated"
  # Remove only exact interface-scoped rules owned by these seven bridges.
  # This also removes superseded broad backup ACCEPT rules from run 8.
  for tool in iptables ip6tables; do
    for chain in INPUT DOCKER-USER OUTPUT; do
      while read -r line; do
        read -r -a args <<< "$line"
        "$tool" -w 5 -D "$chain" "${args[@]:2}"
      done < <("$tool" -S "$chain" | awk -v names="${BRIDGES[*]}" '
        BEGIN {split(names,b," "); for(i in b) own[b[i]]=1}
        /^-A / && !/railway-exit-maintenance/ {
          for(i=1;i<=NF;i++) if(($i=="-i" || $i=="-o") && own[$(i+1)]) {print; break}
        }')
    done
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
  watchdog) exec /bin/bash /boot/config/railway-exit-watchdog.sh;;
  start)
    exec 9>"/run/railway-exit-firewall.lock"; flock 9; start_tunnel;;
  apply)
    exec 9>"/run/railway-exit-firewall.lock"; flock 9
    apply
    nohup /bin/bash /boot/config/railway-exit-watchdog.sh 9>&- >>/var/log/railway-exit-fw.log 2>&1 </dev/null &
    start_tunnel;;
  *) echo 'usage: firewall.sh {apply|verify|start|watchdog|rules}' >&2; exit 2;;
esac
