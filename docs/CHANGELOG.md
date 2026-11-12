# Changelog

## 0.1.1 · 2026-11-11 · Hosted on Cloudflare

Added

- `apps/cloudflare`: one Worker fronting the API and web containers on a single origin, deployed by Workers Builds.
- Demo storage: the API image can carry PostgreSQL (`RUNTIME_BASE=pgvector/pgvector:pg16`) and start a container-local database when none is configured. Labelled in the interface and on `/health`; refused in prod.
- One-secret durable setup on Cloudflare: outside prod the session secret and role passwords are derived from `DATABASE_URL`.
- `infra/docker/smoke.sh` and a CI job that builds, runs and smoke-tests every image.
- Single-container switches: `AE_EMBEDDED_WORKER`, `AE_EMBEDDED_DEV_PROVIDER`, `AE_EMBEDDED_DATABASE`.
- `AE_SIGNUP_ALLOWLIST`: optional restriction of registration to listed addresses and domains.
- Cloudflare edge guard: scanner paths and `robots.txt` (outside prod) are answered by the Worker without waking a container; the API warm-up runs only for browser navigations.

Fixed

- API and worker images did not build (build script and base TypeScript config missing from the context) and would not have resolved their dependencies at runtime (pnpm layout flattened).
- `/health` no longer echoes database error text; it reports `unreachable` and logs the cause.
- Re-running the registry seed inserted a second copy of every model without a version label, because the unique constraint treated NULL versions as distinct. Migration 0009 retires any copies and makes the identity unique; the container entrypoint seeds on every start, so this had to hold.

Changed

- Publishing images to GHCR from CI is opt-in (`PUBLISH_IMAGES=true`).
- The API image's entrypoint runs migrations and the registry seed before serving.

## 0.1.0 · 2026-11-08 · First vertical slice

Added

- Monorepo with 14 packages, 3 apps, 1 tool; pnpm workspaces; lint, format, typecheck and three Vitest projects.
- PostgreSQL schema (8 migrations) with pgvector, two application roles and forced row-level security on every tenant table; append-only audit, provenance, authorization-decision and model-status tables.
- Domain contracts (Zod) for identity, workspace, authorization, conversation, message, model run, context manifest, citation, provenance, knowledge object, answer record, events, evaluation and research.
- Identity: registration, scrypt passwords, HMAC-hashed opaque sessions, rotating refresh with reuse detection, lockout, personal workspace.
- Centralized deny-by-default authorization with 12 policies and durable decision records.
- Model Gateway with OpenAI-compatible and Anthropic adapters, credential broker, budget guard, configuration probe.
- Model Registry with versioned identities, seed, status history and evaluation-gated approval.
- Deterministic Auto routing with explainable exclusions.
- Ask pipeline: context manifest, hybrid retrieval with in-SQL governance, streaming, fallback on transient failures, refusal classification, answer records with citations, claims, limitations and answer path; Compare in parallel lanes.
- Knowledge ingestion worker (chunk, embed, index) with provenance; hybrid search endpoint.
- Evaluation harness with deterministic graders, three starter suites and an operator CLI.
- Fastify API (auth, workspaces, projects, conversations with SSE, knowledge, models, account, audit, health, metrics).
- Next.js web app: premium light three-region shell, home composer, Ask with streaming and citation chips, context panel, Knowledge, Projects, Models and Model detail, Controls, History, Research placeholder; responsive to phone width.
- Labelled development provider (OpenAI-compatible stub) so the full pipeline runs without external keys.
- Dockerfiles, docker-compose, Terraform module with dev/uat/prod stacks, GitHub Actions CI.
- Documentation set and STATUS.md running record.

Tests: 106 passing (73 unit, 11 integration, 21 authorization) plus an 8-step browser smoke test.
