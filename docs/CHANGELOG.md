# Changelog

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
