#!/bin/bash
set -euo pipefail
source "$(dirname -- "$0")/run-common.sh"
exec "${COMMAND[@]}" "${COMMON[@]}" \
  --name myskills-postgres \
  --restart unless-stopped \
  --user 70:70 \
  --memory 512m \
  --network name=myskills-db,ip=172.30.41.2 \
  --env-file /mnt/cache/appdata/myskills/secrets/postgres.env \
  --mount type=bind,src=/mnt/cache/appdata/myskills/postgres,dst=/var/lib/postgresql \
  --tmpfs /var/run/postgresql:uid=70,gid=70,mode=0700,size=16m \
  "${IMAGE_POSTGRES}" postgres -c password_encryption=scram-sha-256
