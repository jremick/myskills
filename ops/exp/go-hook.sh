# railway-exit Phase 0: firewall verification gates tunnel startup.
(
  for attempt in $(seq 1 120); do
    if iptables -nL DOCKER-USER >/dev/null 2>&1 && ip6tables -nL DOCKER-USER >/dev/null 2>&1; then
      if bash /boot/config/cf-ips.sh refresh && bash /boot/config/myskills-fw.sh && bash /boot/config/forgetbase-fw.sh start; then
        exit 0
      fi
      break
    fi
    sleep 5
  done
  for tunnel in myskills-tunnel forgetbase-tunnel; do
    docker container inspect "$tunnel" >/dev/null 2>&1 && timeout 5 docker stop --time 1 "$tunnel" >/dev/null 2>&1
  done
  echo 'railway-exit: boot verification failed; tunnels stopped'
  if test -x /usr/local/emhttp/webGui/scripts/notify; then
    /usr/local/emhttp/webGui/scripts/notify -e 'Railway exit firewall' -s 'Railway exit boot failed' -d 'Tunnels remain stopped' -i alert
  fi
) >> /var/log/railway-exit-fw.log 2>&1 &
