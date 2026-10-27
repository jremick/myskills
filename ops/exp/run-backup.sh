#!/bin/bash
set -euo pipefail
source "$(dirname -- "$0")/run-common.sh"
exec "${COMMAND[@]}" "${COMMON[@]}" \
  --name myskills-backup \
  --dns 1.1.1.1 --dns 1.0.0.1 \
  --restart no \
  --user 70:70 \
  --memory 128m \
  --network name=myskills-net,ip=172.30.40.5 \
  --network name=myskills-db,ip=172.30.41.5 \
  --env-file /mnt/cache/appdata/myskills/secrets/backup.env \
  --mount type=bind,src=/mnt/cache/appdata/myskills/bin/backup.sh,dst=/opt/exp/backup.sh,readonly \
  "${IMAGE_BACKUP}"
