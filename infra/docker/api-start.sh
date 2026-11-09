#!/bin/sh
# Container entrypoint: migrate, seed the registry, then serve.
set -e
export AE_MIGRATIONS_DIR="${AE_MIGRATIONS_DIR:-/app/migrations}"
export AE_MODEL_SEED_PATH="${AE_MODEL_SEED_PATH:-/app/config/models.seed.json}"
echo "[start] running migrations"
node dist/migrate.js migrate
echo "[start] seeding model registry"
node dist/seed.js
echo "[start] starting api"
exec node dist/server.js
