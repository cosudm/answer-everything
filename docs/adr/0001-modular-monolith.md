# ADR-0001: Modular monolith with asynchronous workers

Status: Accepted · 2026-11-08

## Context

The brief forbids Kubernetes, graph databases and dozens of microservices unless measured usage justifies them, yet requires clear domain boundaries (identity, authorization, knowledge, gateway, registry, evaluation, provenance).

## Decision

One pnpm workspace with feature packages that have an explicit dependency order (`domain → database → observability → provenance → identity/authorization/events → registry → gateway → knowledge/evaluation → orchestration → apps`). Three processes: `api`, `worker`, `web`. Packages are consumed as TypeScript source in development and bundled per app for production (`scripts/build-node.mjs`).

## Consequences

Boundaries are enforced by package manifests rather than network hops; any package can later become a service without rewriting callers. `orchestration` was added to the brief's package list to hold the Ask pipeline, which spans several domains.
