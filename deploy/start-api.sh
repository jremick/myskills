#!/bin/sh
set -eu

node apps/api/dist/db/migrate.js

if [ -n "${SEED_OWNER_PASSWORD:-}" ]; then
  node apps/api/dist/db/seed.js
fi

exec node apps/api/dist/server.js
