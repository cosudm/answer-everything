# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /repo

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/worker ./apps/worker
COPY packages ./packages
COPY tools ./tools
RUN pnpm install --frozen-lockfile --filter @ae/worker...
RUN pnpm --filter @ae/worker build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup --system ae && adduser --system --ingroup ae ae
COPY --from=build /repo/apps/worker/dist ./dist
COPY --from=build /repo/node_modules ./node_modules
USER ae
CMD ["node", "dist/main.js"]
