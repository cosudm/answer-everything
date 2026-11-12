# Answer Everything API. Build from the repository root:
#   docker build -f infra/docker/api.Dockerfile -t ae-api .
#
# RUNTIME_BASE chooses what the final image runs on:
#   node:22-bookworm-slim    (default) lean image for environments with a managed PostgreSQL
#   pgvector/pgvector:pg16   adds PostgreSQL + pgvector, so the entrypoint can start a
#                            container-local, NON-DURABLE database when
#                            AE_EMBEDDED_DATABASE=true and DATABASE_URL is unset.
#                            Demo environments only; refused when AE_ENV=prod.
ARG RUNTIME_BASE=node:22-bookworm-slim

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /repo

FROM base AS source
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc tsconfig.base.json ./
COPY scripts ./scripts
COPY packages ./packages
COPY tools ./tools
COPY apps/api ./apps/api

FROM source AS build
RUN pnpm install --frozen-lockfile --filter "@ae/api..."
RUN pnpm --filter @ae/api build

# Production dependencies only, in the layout pnpm links them, so the runtime
# stage can copy the two node_modules directories exactly as they are.
FROM source AS prod-deps
RUN pnpm install --frozen-lockfile --prod --filter "@ae/api..."

FROM ${RUNTIME_BASE} AS runtime
# Both supported bases are Debian, so the Node binary from the build image runs on either.
COPY --from=base /usr/local/bin/node /usr/local/bin/node
ENV NODE_ENV=production \
    AE_MIGRATIONS_DIR=/app/migrations \
    AE_MODEL_SEED_PATH=/app/config/models.seed.json
RUN useradd --uid 10001 --user-group --create-home --shell /usr/sbin/nologin ae \
 && mkdir -p /app /var/lib/ae \
 && chown ae:ae /var/lib/ae
WORKDIR /app
# The bundles in dist/ resolve third-party packages from apps/api/node_modules,
# whose entries are symlinks into /app/node_modules/.pnpm. Keep both in place.
COPY --from=prod-deps /repo/node_modules ./node_modules
COPY --from=prod-deps /repo/apps/api/node_modules ./apps/api/node_modules
COPY --from=build /repo/apps/api/dist ./apps/api/dist
COPY packages/database/migrations ./migrations
COPY config ./config
COPY infra/docker/api-start.sh ./start.sh
RUN chmod 0755 /app/start.sh
USER ae
WORKDIR /app/apps/api
EXPOSE 4000
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s CMD node -e "fetch('http://127.0.0.1:4000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# start.sh runs migrations, seeds the registry and serves; arguments replace that.
ENTRYPOINT ["/app/start.sh"]
