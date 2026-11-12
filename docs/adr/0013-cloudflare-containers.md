# ADR-0013: Cloudflare Workers + Containers as the first hosted environment

Status: Accepted · 2026-11-09

## Context

The owner wants a reachable URL now and already runs the product family on Cloudflare (Workers Paid plan). The build environment cannot reach Cloudflare's API directly, but Workers Builds can build Dockerfiles and roll out Containers from a GitHub repository.

## Decision

Add `apps/cloudflare`: a Worker that routes `/v1/*`, `/health`, `/metrics` to an API container and everything else to a web container, both built from the existing Dockerfiles. The API container runs migrations and the registry seed on start, then Fastify with the embedded job runner (`AE_EMBEDDED_WORKER`) and, outside prod, the labelled dev provider (`AE_EMBEDDED_DEV_PROVIDER`). The web image is built with `NEXT_PUBLIC_API_URL=""` for same-origin calls. Postgres is external (Neon/Supabase); role connection strings are derived from one `DATABASE_URL` plus two role passwords. Secrets are Worker secrets forwarded to the container at start.

## Consequences

The Azure Terraform stack remains the reference for DEV/UAT/PROD; Cloudflare is the fast path. Cold starts after idle are visible to users. Running the job runner in the API container is a deliberate simplification to undo when load warrants a separate worker container.

## Amendment · 2026-11-11

The first deployment attempt showed two gaps: the images had never been built by a real Docker engine (the build script and base TypeScript config were missing from the context, and the runtime stage flattened pnpm's module layout), and requiring an external database plus four secrets before anything could be seen made the fast path slow.

Changes:

- **Images.** The API and worker images now copy pnpm's two `node_modules` levels as linked and run from `apps/<name>`. CI builds all three images, runs them, and drives the API through sign-up, ingestion and a cited answer (`infra/docker/smoke.sh`).
- **Demo storage.** `api.Dockerfile` takes `RUNTIME_BASE`. With `pgvector/pgvector:pg16` the image also carries PostgreSQL, and the entrypoint starts a container-local database when `AE_EMBEDDED_DATABASE=true` and `DATABASE_URL` is unset. It is the real schema with row-level security, but nothing survives a restart; `/health` reports `storage: "ephemeral"` and the interface labels it. The entrypoint and the API both refuse it when `AE_ENV=prod`. The default image (`node:22-bookworm-slim`) contains no database and fails fast if asked for one.
- **One secret to go durable.** Outside prod the Worker derives the session secret and the two role passwords from `DATABASE_URL` with HMAC-SHA256. Whoever holds the connection string already controls the database and every session row in it, so this does not widen what that secret protects. In prod nothing is derived and missing secrets are named in a 503.
- **Configuration changes restart the API.** The container instance is named after a hash of its environment.
- **`/metrics` is no longer routed** through the public Worker.

Trade-off accepted: the Cloudflare API image is larger (PostgreSQL binaries) even after a durable database is configured. The lean image remains the default for every other target.
