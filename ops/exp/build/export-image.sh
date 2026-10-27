#!/usr/bin/env bash
set -euo pipefail

: "${IMAGE_REPOSITORY:?}"
: "${IMAGE_DIGEST:?}"
: "${IMAGE_TAG:?}"
: "${SOURCE_BASE_SHA:?}"
: "${GITHUB_SHA:?}"
: "${GITHUB_STEP_SUMMARY:?}"
: "${GITHUB_SERVER_URL:?}"
: "${GITHUB_REPOSITORY:?}"
: "${GITHUB_RUN_ID:?}"

[[ "$IMAGE_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]]
image_ref="${IMAGE_REPOSITORY}@${IMAGE_DIGEST}"
docker pull --platform linux/amd64 "$image_ref"
docker tag "$image_ref" "$IMAGE_TAG"
image_id="$(docker image inspect --format '{{.Id}}' "$image_ref")"
[[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]]
test "$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$image_ref")" = linux/amd64

mkdir -p image-artifact
# Validate syntax and tools only. Never invoke an application or backup entrypoint.
smoke_flags=(
  --rm --network none --read-only --cap-drop ALL
  --security-opt no-new-privileges --tmpfs /tmp:rw,noexec,nosuid,size=64m
  --pids-limit 256 --memory 256m --cpus 1
)
case "$IMAGE_REPOSITORY" in
  ghcr.io/jremick/myskills-exp-api)
    docker run "${smoke_flags[@]}" --entrypoint sh "$image_ref" -ec \
      'node --check apps/api/dist/server.js && node --check apps/api/dist/db/migrate.js' \
      2>&1 | tee image-artifact/smoke-checks.log
    ;;
  ghcr.io/jremick/myskills-exp-web)
    docker run "${smoke_flags[@]}" --entrypoint nginx "$image_ref" \
      -t -c /opt/exp/nginx.conf 2>&1 | tee image-artifact/smoke-checks.log
    ;;
  ghcr.io/jremick/myskills-exp-backup)
    docker run "${smoke_flags[@]}" --entrypoint sh "$image_ref" -ec '
      for executable in pg_dump pg_restore psql age rclone bash tar sha256sum curl; do
        command -v "$executable"
      done
      pg_dump --version
      pg_restore --version
      psql --version
      age --version
      rclone version
      bash --version
      tar --version
      sha256sum /dev/null
      curl --version
    ' 2>&1 | tee image-artifact/smoke-checks.log
    ;;
  *)
    printf 'Unsupported image repository for smoke check\n' >&2
    exit 1
    ;;
esac
docker save --output image-artifact/image.tar "$IMAGE_TAG"
(
  cd image-artifact
  sha256sum image.tar > image.tar.sha256
)
export IMAGE_ID="$image_id"
export IMAGE_REF="$image_ref"
python3 - <<'PY'
import json
import os
from pathlib import Path

archive_sha256 = Path("image-artifact/image.tar.sha256").read_text().split()[0]
metadata = {
    "source_base_sha": os.environ["SOURCE_BASE_SHA"],
    "build_commit_sha": os.environ["GITHUB_SHA"],
    "platform": "linux/amd64",
    "image_ref": os.environ["IMAGE_REF"],
    "image_tag": os.environ["IMAGE_TAG"],
    "image_digest": os.environ["IMAGE_DIGEST"],
    "image_id": os.environ["IMAGE_ID"],
    "archive": "image.tar",
    "archive_sha256": archive_sha256,
    "smoke_checks": "passed; see smoke-checks.log",
    "run_url": (
        f'{os.environ["GITHUB_SERVER_URL"]}/{os.environ["GITHUB_REPOSITORY"]}'
        f'/actions/runs/{os.environ["GITHUB_RUN_ID"]}'
    ),
}
Path("image-artifact/metadata.json").write_text(json.dumps(metadata, indent=2) + "\n")
with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as summary:
    summary.write(f'### {metadata["image_tag"]}\n\n')
    summary.write("| Field | Value |\n|---|---|\n")
    for key, value in metadata.items():
        summary.write(f"| {key} | `{value}` |\n")
    summary.write("\nVerify archive_sha256 before transfer, then compare the loaded image ID.\n")
PY
