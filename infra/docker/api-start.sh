#!/bin/sh
# Container entrypoint for the API image.
#
#   1. optional: start a container-local PostgreSQL (demo environments only)
#   2. apply migrations and create the application roles
#   3. seed the model registry
#   4. serve
#
# Any arguments replace the default behaviour, so one-off commands still work:
#   docker run ae-api node dist/migrate.js status
set -eu

if [ "$#" -gt 0 ]; then
  exec "$@"
fi

export AE_MIGRATIONS_DIR="${AE_MIGRATIONS_DIR:-/app/migrations}"
export AE_MODEL_SEED_PATH="${AE_MODEL_SEED_PATH:-/app/config/models.seed.json}"

random_secret() {
  node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))"
}

find_pg_bin() {
  if command -v initdb >/dev/null 2>&1; then
    dirname "$(command -v initdb)"
    return 0
  fi
  for dir in /usr/lib/postgresql/*/bin; do
    if [ -x "$dir/initdb" ]; then
      echo "$dir"
      return 0
    fi
  done
  return 1
}

# --- Embedded database --------------------------------------------------------
# With no DATABASE_URL and AE_EMBEDDED_DATABASE=true, run PostgreSQL inside this
# container. Everything it stores is lost when the container stops, so this is
# for demo environments only and the API reports it as storage "ephemeral".
if [ -z "${DATABASE_URL:-}" ] && [ "${AE_EMBEDDED_DATABASE:-false}" = "true" ]; then
  if [ "${AE_ENV:-dev}" = "prod" ]; then
    echo "[start] AE_EMBEDDED_DATABASE is not allowed when AE_ENV=prod; set DATABASE_URL" >&2
    exit 1
  fi
  if ! PG_BIN="$(find_pg_bin)"; then
    echo "[start] AE_EMBEDDED_DATABASE=true but this image has no PostgreSQL." >&2
    echo "[start] Build it with --build-arg RUNTIME_BASE=pgvector/pgvector:pg16, or set DATABASE_URL." >&2
    exit 1
  fi

  PG_DATA="${AE_EMBEDDED_PGDATA:-/var/lib/ae/pgdata}"
  PG_PORT="${AE_EMBEDDED_PGPORT:-5432}"
  echo "[start] no DATABASE_URL: starting a container-local PostgreSQL (data is NOT durable)"

  if [ ! -s "$PG_DATA/PG_VERSION" ]; then
    mkdir -p "$PG_DATA"
    "$PG_BIN/initdb" -D "$PG_DATA" -U postgres --auth=trust --encoding=UTF8 --locale=C.UTF-8 --no-sync >/dev/null
  fi

  # Loopback only, trust authentication: nothing outside this container can
  # reach it. Durability settings are off because the data is disposable.
  if ! "$PG_BIN/pg_ctl" -D "$PG_DATA" -w -t 90 -l "$PG_DATA/server.log" \
    -o "-p $PG_PORT -c listen_addresses=127.0.0.1 -k /tmp -c shared_buffers=64MB -c max_connections=60 -c fsync=off -c synchronous_commit=off -c full_page_writes=off" \
    start >/dev/null; then
    echo "[start] PostgreSQL failed to start:" >&2
    tail -n 40 "$PG_DATA/server.log" >&2 || true
    exit 1
  fi

  if ! "$PG_BIN/psql" -h 127.0.0.1 -p "$PG_PORT" -U postgres -d postgres -tAc \
    "SELECT 1 FROM pg_database WHERE datname = 'answer_everything'" | grep -q 1; then
    "$PG_BIN/createdb" -h 127.0.0.1 -p "$PG_PORT" -U postgres answer_everything
  fi

  export DATABASE_URL="postgres://postgres@127.0.0.1:$PG_PORT/answer_everything"
  export AE_STORAGE_EPHEMERAL=true
  # Fresh secrets per boot are fine here: the database they protect is new too.
  export AE_DB_APP_PASSWORD="${AE_DB_APP_PASSWORD:-$(random_secret)}"
  export AE_DB_IDENTITY_PASSWORD="${AE_DB_IDENTITY_PASSWORD:-$(random_secret)}"
  export AE_SESSION_SECRET="${AE_SESSION_SECRET:-$(random_secret)}"
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "[start] DATABASE_URL is not set (and AE_EMBEDDED_DATABASE is not enabled)" >&2
  exit 1
fi

echo "[start] running migrations"
node dist/migrate.js migrate
echo "[start] seeding model registry"
node dist/seed.js
echo "[start] starting api"
exec node dist/server.js
