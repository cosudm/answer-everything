# Answer Everything job worker. Build from the repository root:
#   docker build -f infra/docker/worker.Dockerfile -t ae-worker .
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /repo

FROM base AS source
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc tsconfig.base.json ./
COPY scripts ./scripts
COPY packages ./packages
COPY tools ./tools
COPY apps/worker ./apps/worker

FROM source AS build
RUN pnpm install --frozen-lockfile --filter "@ae/worker..."
RUN pnpm --filter @ae/worker build

FROM source AS prod-deps
RUN pnpm install --frozen-lockfile --prod --filter "@ae/worker..."

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
# dist/main.js resolves third-party packages from apps/worker/node_modules,
# whose entries are symlinks into /app/node_modules/.pnpm. Keep both in place.
COPY --from=prod-deps /repo/node_modules ./node_modules
COPY --from=prod-deps /repo/apps/worker/node_modules ./apps/worker/node_modules
COPY --from=build /repo/apps/worker/dist ./apps/worker/dist
USER node
WORKDIR /app/apps/worker
CMD ["node", "dist/main.js"]
