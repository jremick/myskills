#!/bin/bash
set -euo pipefail
source "$(dirname -- "$0")/run-common.sh"
exec "${COMMAND[@]}" "${COMMON[@]}" \
  --name myskills-web \
  --restart unless-stopped \
  --user 101:101 \
  --memory 64m \
  --network name=myskills-net,ip=172.30.40.3 \
  --env-file /mnt/cache/appdata/myskills/secrets/web.env \
  --tmpfs /etc/nginx/conf.d:uid=101,gid=101,mode=0700,size=1m \
  --tmpfs /var/cache/nginx:uid=101,gid=101,mode=0700,size=16m \
  --tmpfs /var/run:uid=101,gid=101,mode=0700,size=1m \
  "${IMAGE_WEB}"
