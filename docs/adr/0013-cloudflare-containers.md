# ADR-0013: Cloudflare Workers + Containers as the first hosted environment

Status: Accepted · 2026-11-09

## Context

The owner wants a reachable URL now and already runs the product family on Cloudflare (Workers Paid plan). The build environment cannot reach Cloudflare's API directly, but Workers Builds can build Dockerfiles and roll out Containers from a GitHub repository.

## Decision

Add `apps/cloudflare`: a Worker that routes `/v1/*`, `/health`, `/metrics` to an API container and everything else to a web container, both built from the existing Dockerfiles. The API container runs migrations and the registry seed on start, then Fastify with the embedded job runner (`AE_EMBEDDED_WORKER`) and, outside prod, the labelled dev provider (`AE_EMBEDDED_DEV_PROVIDER`). The web image is built with `NEXT_PUBLIC_API_URL=""` for same-origin calls. Postgres is external (Neon/Supabase); role connection strings are derived from one `DATABASE_URL` plus two role passwords. Secrets are Worker secrets forwarded to the container at start.

## Consequences

The Azure Terraform stack remains the reference for DEV/UAT/PROD; Cloudflare is the fast path. Cold starts after idle are visible to users. Running the job runner in the API container is a deliberate simplification to undo when load warrants a separate worker container.
