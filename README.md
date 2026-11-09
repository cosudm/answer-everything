# Answer Everything

> Ask anything. Get the strongest available answer, and see what supports it.

Answer Everything is a model-agnostic intelligence platform. It brings every approved model to the question you are asking, grounds answers in your governed knowledge, records what supported each answer, which intelligence produced it, and what the platform was authorized to access. Models are replaceable capabilities; identity, authorization, provenance and evidence are the product.

This repository holds the MVP: a modular monolith with asynchronous workers, built with Next.js, Fastify, TypeScript and PostgreSQL with pgvector.

## What works today

- Sign up, sign in, personal workspace, rotating sessions.
- Ask: streaming answers with the Auto router choosing an approved model, workspace knowledge retrieved and cited, an answer record with claims, citations, limitations and an answer path, cost and token telemetry.
- Compare: 2–4 models answer the same question side by side.
- Knowledge: notes and text documents ingested by the worker (chunk, embed, index) with provenance, privacy class and per-item AI-use permission.
- Projects: standing instructions and scoped knowledge.
- Models: versioned registry, evaluation status, health check, evaluation harness with deterministic graders.
- Controls: privacy ceiling, experimental-model opt-in, commercial-provider switch, budget, retention, export, deletion, audit log.

See [STATUS.md](STATUS.md) for the exact state of every area, test results and open risks.

## Quick start

Requirements: Node 22, pnpm 10, PostgreSQL 16 with the `vector` extension (or Docker).

```bash
cp .env.example .env            # fill provider keys if you have them; none are required to run
pnpm install
pnpm db:migrate                 # creates roles ae_app / ae_identity and applies migrations
pnpm db:seed                    # registers providers and models from config/models.seed.json
pnpm dev                        # web :3000, api :4000, worker, local dev provider :4100
```

Open http://localhost:3000, create an account, add a note under Knowledge, and ask a question about it.

Without provider keys the Auto router selects the **Local Development Model (stub)**: a labelled, deterministic OpenAI-compatible server that quotes your sources so the whole pipeline (retrieval, citations, answer records, cost ledger) runs for real. It is never enabled when `AE_ENV=prod`. Add `ANTHROPIC_API_KEY` (or another provider) to `.env` and the router prefers the real model.

With Docker: `docker compose up` starts PostgreSQL (pgvector), migrations and seed, the dev provider, API, worker and web.

## Repository layout

```
apps/
  web/            Next.js application (premium light three-region workspace)
  api/            Fastify API: auth, workspaces, conversations (SSE), knowledge, models, account
  worker/         Asynchronous job runner (ingestion, evaluation)
packages/
  domain/         Zod contracts: identity, workspace, authorization, conversation, message, model run,
                  context manifest, citation, provenance, knowledge object, answer record, events, evaluation
  database/       Migrations, RLS, roles, tenant-context helpers, test support
  identity/       Registration, sessions, workspaces, projects
  authorization/  Deny-by-default policy engine and decision recording
  model-gateway/  Provider-neutral gateway, OpenAI-compatible and Anthropic adapters, credential broker
  model-registry/ Versioned model identities, routing, seed
  knowledge/      Chunking, ingestion, hybrid retrieval
  orchestration/  Context manifest, Ask/Compare pipeline, model runs, budget, jobs
  provenance/     Audit, provenance, answer records, claim classification
  evaluation/     Graders, suites, runner
  research/       Research task contracts and planner
  events/         PostgreSQL job queue behind a broker-neutral interface, in-process event bus
  observability/  Logging, tracing hooks, metrics
  ui/             (reserved for shared UI once a second front end exists)
tools/dev-provider/  Labelled OpenAI-compatible development stub
infra/            Dockerfiles, Terraform (dev / uat / prod), compose
docs/             Architecture, product, security, threat model, registry, evaluation, data governance, API, deployment, ADRs, roadmap, changelog
```

## Scripts

| Command                                              | Purpose                                                                                                 |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `pnpm dev`                                           | Run everything in watch mode                                                                            |
| `pnpm test`                                          | Unit + integration + authorization (integration suites need `DATABASE_URL`; they skip loudly otherwise) |
| `pnpm test:authorization`                            | The isolation proofs only                                                                               |
| `pnpm typecheck` / `pnpm lint` / `pnpm format:check` | Quality gates used by CI                                                                                |
| `pnpm db:migrate` / `pnpm db:seed` / `pnpm db:reset` | Database lifecycle (reset refuses in prod)                                                              |
| `pnpm --filter @ae/api build`                        | Production bundles (`dist/server.js`, `dist/migrate.js`, `dist/seed.js`)                                |
| `node test/e2e-smoke.mjs`                            | Headless browser walk-through of the vertical slice (needs Playwright)                                  |

## Documentation

[ARCHITECTURE](docs/ARCHITECTURE.md) · [PRODUCT](docs/PRODUCT.md) · [SECURITY](docs/SECURITY.md) · [THREAT_MODEL](docs/THREAT_MODEL.md) · [MODEL_REGISTRY](docs/MODEL_REGISTRY.md) · [MODEL_EVALUATION](docs/MODEL_EVALUATION.md) · [DATA_GOVERNANCE](docs/DATA_GOVERNANCE.md) · [API](docs/API.md) · [DEPLOYMENT](docs/DEPLOYMENT.md) · [DECISIONS](docs/DECISIONS.md) · [ROADMAP](docs/ROADMAP.md) · [CHANGELOG](docs/CHANGELOG.md)

## Principles in one paragraph

Answer first. Evidence over confidence. Models are replaceable. Capability is not authority: a model's willingness to answer never grants access to data or actions; centralized authorization and PostgreSQL row-level security decide, before retrieval and before every model call. Private by default. When the platform cannot answer, it says exactly why: insufficient evidence, provider restriction, authorization, unsupported capability or failure, never a generic refusal.
