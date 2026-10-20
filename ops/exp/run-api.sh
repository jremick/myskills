#!/bin/bash
set -euo pipefail
source "$(dirname -- "$0")/run-common.sh"
exec "${COMMAND[@]}" "${COMMON[@]}" \
  --name myskills-api \
  --restart unless-stopped \
  --user 1000:1000 \
  --memory 512m \
  --network name=myskills-net,ip=172.30.40.4 \
  --network name=myskills-db,ip=172.30.41.4 \
  --env-file /mnt/cache/appdata/myskills/secrets/api.env \
  "${IMAGE_API}"
