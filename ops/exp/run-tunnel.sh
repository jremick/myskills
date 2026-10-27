#!/bin/bash
set -euo pipefail
APP=myskills
BASE=/mnt/cache/appdata/$APP
[[ "${1:-}" == start-verified ]] || { echo 'Start through the firewall script only.' >&2; exit 2; }
bash "/boot/config/$APP-fw.sh" verify
[[ -f "$BASE/secrets/tunnel.env" ]] || { echo "$APP: tunnel.env absent; tunnel start skipped"; exit 0; }
[[ "$(stat -c '%a:%u' "$BASE/secrets/tunnel.env")" == 600:0 ]]
source "$BASE/bin/images.conf"
if docker container inspect "$APP-tunnel" >/dev/null 2>&1; then
  [[ "$(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$APP-tunnel")" == no ]]
  exec docker start "$APP-tunnel"
fi
exec docker run -d --name "$APP-tunnel" --restart no --user 65532:65532 \
  --dns 1.1.1.1 --dns 1.0.0.1 \
  --network myskills-net --ip 172.30.40.2 \
  --cap-drop ALL --security-opt no-new-privileges --read-only --tmpfs /tmp:size=64m \
  --pids-limit 256 --memory 128m --cpus 1 --log-opt max-size=10m --log-opt max-file=3 \
  --env-file "$BASE/secrets/tunnel.env" "$IMAGE_TUNNEL" tunnel --no-autoupdate run
