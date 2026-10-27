#!/bin/bash
# Public data only. A failed fetch never overwrites the last validated list.
set -euo pipefail
validate() {
  php /dev/stdin "$1" <<'PHP'
<?php
$lines = @file($argv[1], FILE_IGNORE_NEW_LINES);
if ($lines === false || count($lines) < 10 || count($lines) > 40 || count(array_unique($lines)) !== count($lines)) exit(1);
$blocked = ['0.0.0.0/8','10.0.0.0/8','100.64.0.0/10','127.0.0.0/8','169.254.0.0/16','172.16.0.0/12','192.0.0.0/24','192.0.2.0/24','192.168.0.0/16','198.18.0.0/15','198.51.100.0/24','203.0.113.0/24','224.0.0.0/3'];
foreach ($lines as $line) {
  if (!preg_match('~^([0-9.]+)/([0-9]|[12][0-9]|3[0-2])$~D', $line, $m)) exit(1);
  if (!filter_var($m[1], FILTER_VALIDATE_IP, FILTER_FLAG_IPV4)) exit(1);
  $start = ip2long($m[1]); $size = 2 ** (32 - (int)$m[2]); $end = $start + $size - 1;
  if ($start % $size !== 0) exit(1);
  foreach ($blocked as $cidr) {
    [$ip,$prefix] = explode('/', $cidr); $lo = ip2long($ip); $hi = $lo + 2 ** (32-(int)$prefix) - 1;
    if ($start <= $hi && $end >= $lo) exit(1);
  }
}
PHP
}
case "${1:-refresh}" in
  validate) validate "$2";;
  refresh)
    file=/boot/config/cf-ips-v4.txt
    candidate=$(mktemp /boot/config/cf-ips-v4.XXXXXX)
    trap 'rm -f -- "$candidate"' EXIT
    if curl --fail --silent --show-error --proto '=https' --tlsv1.2 --connect-timeout 10 --max-time 30 \
      https://www.cloudflare.com/ips-v4 > "$candidate" && validate "$candidate"; then
      # Normalize the final newline so the shell reads every CIDR.
      sed -i -e '$a\' "$candidate"
      chmod 600 "$candidate"
      mv "$candidate" "$file"
      echo 'cf-v4: validated live list installed'
    else
      echo 'cf-v4: refresh rejected; retaining last good copy' >&2
    fi
    validate "$file";;
  *) exit 2;;
esac
