# Answer Everything web app (Next.js standalone). Build from the repository root:
#   docker build -f infra/docker/web.Dockerfile -t ae-web .
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /repo

FROM base AS build
# Where the browser finds the API. Empty means "same origin": the page calls
# /v1/* on the host that served it (single-origin deployments such as Cloudflare).
ARG NEXT_PUBLIC_API_URL=""
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc tsconfig.base.json ./
COPY packages/domain ./packages/domain
COPY apps/web ./apps/web
RUN pnpm install --frozen-lockfile --filter "@ae/web..."
RUN pnpm --filter @ae/web build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
