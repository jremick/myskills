#!/bin/bash
set -euo pipefail
source "$(dirname -- "$0")/run-common.sh"
exec "${COMMAND[@]}" "${COMMON[@]}" \
  --name myskills-migrate \
  --restart no \
  --user 1000:1000 \
  --memory 256m \
  --network name=myskills-db,ip=172.30.41.6 \
  --env-file /mnt/cache/appdata/myskills/secrets/migrate.env \
  "${IMAGE_API}" node apps/api/dist/db/migrate.js
