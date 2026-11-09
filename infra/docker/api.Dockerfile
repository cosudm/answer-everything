# syntax=docker/dockerfile:1.7
# Answer Everything API. Built from the monorepo root:
#   docker build -f infra/docker/api.Dockerfile -t ae-api .
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /repo

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/api/package.json apps/api/
COPY packages ./packages
COPY tools ./tools
RUN find packages tools -mindepth 2 -maxdepth 2 ! -name package.json -exec rm -rf {} + 2>/dev/null || true
RUN pnpm install --frozen-lockfile --filter @ae/api...

FROM deps AS build
COPY packages ./packages
COPY tools ./tools
COPY apps/api ./apps/api
COPY config ./config
RUN pnpm --filter @ae/api build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup --system ae && adduser --system --ingroup ae ae
COPY --from=build /repo/apps/api/dist ./dist
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/packages/database/migrations ./migrations
COPY --from=build /repo/config ./config
USER ae
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://localhost:4000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
