# Decisions

Architecture decision records live in `docs/adr/`. Every material decision gets an ADR with context, decision and consequences. Status values: Proposed, Accepted, Superseded.

| ADR                                                | Title                                                                                   | Status   |
| -------------------------------------------------- | --------------------------------------------------------------------------------------- | -------- |
| [0001](adr/0001-modular-monolith.md)               | Modular monolith with asynchronous workers                                              | Accepted |
| [0002](adr/0002-postgres-rls-two-roles.md)         | PostgreSQL row-level security with two application roles                                | Accepted |
| [0003](adr/0003-sessions-local-password-first.md)  | Opaque server-side sessions; local passwords first, OIDC behind the same Principal      | Accepted |
| [0004](adr/0004-postgres-job-queue.md)             | PostgreSQL-backed job queue behind a broker-neutral interface                           | Accepted |
| [0005](adr/0005-provider-neutral-gateway.md)       | Provider-neutral Model Gateway with two wire adapters                                   | Accepted |
| [0006](adr/0006-centralized-authorization.md)      | Centralized deny-by-default authorization; decisions persisted in their own transaction | Accepted |
| [0007](adr/0007-embedding-dimension.md)            | Fixed embedding dimension of 1536                                                       | Accepted |
| [0008](adr/0008-labelled-dev-provider.md)          | A labelled development provider instead of silent mocks                                 | Accepted |
| [0009](adr/0009-claim-classification.md)           | Deterministic claim classification by citation coverage; verification pass deferred     | Accepted |
| [0010](adr/0010-routing-configured-and-gated.md)   | Routing excludes unconfigured providers; experimental status is workspace-gated         | Accepted |
| [0011](adr/0011-browser-api-cookies.md)            | Browser calls the API directly with httpOnly cookies and CORS                           | Accepted |
| [0012](adr/0012-terraform-azure-container-apps.md) | Terraform on Azure Container Apps for DEV/UAT/PROD                                      | Accepted |

Smaller decisions recorded in code comments: serif typography for answers (`apps/web/app/globals.css`), heading-aware chunking (`packages/knowledge/src/chunking.ts`), conservative text-refusal detection (`packages/model-gateway/src/util.ts`).
