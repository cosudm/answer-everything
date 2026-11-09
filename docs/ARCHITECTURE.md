# Architecture

## Shape

A modular monolith with asynchronous workers. Three deployable processes share one PostgreSQL database and a set of in-repo packages with explicit dependency direction:

```
                 ┌──────────────┐        ┌──────────────┐        ┌──────────────┐
   browser ───▶  │  apps/web    │  ───▶  │  apps/api    │  ───▶  │  providers   │
                 │  Next.js     │  SSE   │  Fastify     │  HTTPS │  (via gateway)│
                 └──────────────┘        └──────┬───────┘        └──────────────┘
                                                │ jobs (PostgreSQL queue)
                                         ┌──────▼───────┐
                                         │ apps/worker  │ ──▶ gateway (embeddings, evaluations)
                                         └──────┬───────┘
                                                │
                                     ┌──────────▼──────────┐
                                     │ PostgreSQL + pgvector│  RLS enforced for ae_app
                                     └─────────────────────┘
```

Package dependency order (lower depends on nothing above it):

```
domain ◀─ database ◀─ observability ◀─ provenance ◀─ identity, authorization, events
                                      ◀─ model-registry ◀─ model-gateway ◀─ knowledge, evaluation
                                      ◀─ orchestration (uses all of the above) ◀─ apps/api, apps/worker
```

No module calls a provider directly; everything goes through `@ae/model-gateway`. No module touches a tenant table outside `withTenant()`.

## Request lifecycle: Ask

1. **Authenticate.** The API resolves the httpOnly session cookie (or Bearer token) through the identity pool (`ae_identity`, BYPASSRLS, identity tables only) into a `Principal` = user + acting identity + session.
2. **Open tenant context.** Every subsequent query runs inside `withTenant(ae_app pool, {userId, workspaceId, identityId})`, which sets transaction-local `app.*` settings that the RLS policies read. No context, no rows.
3. **Authorize the append.** `AuthorizationService.authorize()` loads facts (identity, membership, workspace settings, model) and evaluates deny-by-default policies. Denials are persisted and audited in their own transaction so a rollback cannot erase them.
4. **Persist the question** and an assistant placeholder (`STREAMING`). Attachments raise the conversation's privacy class.
5. **Route.** `routeModels()` filters by eligibility (enabled, approved or workspace-permitted, cleared for the information's privacy class, mode profile, capability, context, budget) and ranks. Providers without a credential/endpoint are excluded first via `gateway.isConfigured()`.
6. **Build the context manifest.** Retrieval authorization (`knowledge.retrieve_for_model`) yields a privacy ceiling; `hybridSearch()` enforces it, AI-use permission, READY status and project scope **inside SQL**. Sources are labelled `S1..Sn`; history is added newest-first within budget; every considered item, included or dropped, is recorded in an immutable `context_manifests` row.
7. **Authorize the model** for this exact information class, record the decision, start a `model_runs` row.
8. **Stream.** The gateway resolves credentials server-side and the adapter normalizes provider events into the `ModelEvent` vocabulary. Deltas go to the browser as SSE. A retryable provider error before any token falls through to the next candidate; refusals and authorization outcomes never do.
9. **Finalize.** Model run (usage, cost, latency, refusal/error), usage ledger, answer record (disposition, content, citations, claims, confidence basis, limitations, answer path), message, provenance (`GENERATED_BY_MODEL`, `CITED_BY`), audit, domain event.

Transactions are short: steps 3–4, 6, 7 and 9 each commit independently; the provider stream itself holds no database connection.

## Data model

See `packages/database/migrations`. Groups:

- **Identity**: `users`, `acting_identities` (USER / SERVICE / AGENT; agents are bound to a delegating user), `sessions` (HMAC-hashed tokens, rotation chain), `login_attempts`.
- **Tenancy**: `workspaces` (settings JSON validated by `WorkspaceSettings`), `workspace_memberships` (OWNER / ADMIN / MEMBER / VIEWER), `projects`.
- **Models**: `providers` (credentialRef names a secret; never the secret), `model_versions`, `model_status_changes` (append-only).
- **Conversation**: `conversations`, `messages`, `context_manifests`, `model_runs`, `usage_ledger`.
- **Knowledge**: `knowledge_objects` (privacy class, AI-use permission, provenance fields), `knowledge_chunks` (`vector(1536)` + generated `tsvector`, HNSW + GIN indexes).
- **Answer contract**: `answer_records`, `citations`, `answer_claims`.
- **Governance**: `authorization_decisions`, `provenance_records`, `audit_events` (all append-only by trigger).
- **Async**: `jobs` (SKIP LOCKED queue), `evaluation_*`, `research_tasks`.

## Identity Governed Logic

Every protected call answers: WHO (user) AS WHOM (acting identity) IN WHICH WORKSPACE, USING WHICH INFORMATION (privacy class), FOR WHICH PURPOSE, THROUGH WHICH MODEL, WITH WHICH AUTHORITY (role), TO PERFORM WHICH ACTION. That is literally the shape of `AuthorizationRequest`. Two layers enforce it: the policy engine (`@ae/authorization`) and PostgreSQL RLS. The engine can be wrong and RLS still holds; RLS can be misconfigured and the engine still denies. Tests cover both.

## Answer Contract

`AnswerRecord` is produced for every turn, including failures. `disposition` is one of ANSWERED, PARTIALLY_ANSWERED, NEEDS_CLARIFICATION, INSUFFICIENT_EVIDENCE, AUTHORIZATION_DENIED, PROVIDER_RESTRICTED, UNSUPPORTED, FAILED. Claims are classified deterministically by citation coverage (ADR-0009); `confidence` is evidence coverage, never model tone, and is `null` when no sources were available.

## Model Gateway

`ModelGateway { generate, stream, embed, health, isConfigured }`. Two wire adapters cover every listed provider: `anthropic` (Messages API) and `openai-compatible` (OpenAI, DeepSeek, xAI, Perplexity, vLLM, Ollama, TGI, Together, RunPod, the dev stub). Adapters never throw for provider-side problems; they yield `refusal` or `error` events, then `end`. The gateway re-checks privacy clearance and budget (defense in depth), estimates tokens when a provider reports none (flagged `reported: false`), and estimates cost only when pricing is known.

## Asynchronous work

`@ae/events` exposes a broker-neutral `JobQueue`. The MVP implementation is PostgreSQL (`FOR UPDATE SKIP LOCKED`, exponential backoff, DEAD after `max_attempts`). Handlers run AS the requesting user THROUGH the platform SERVICE identity, so RLS still scopes them. Service Bus is provisioned in Terraform for when throughput demands it.

## Front end

Next.js App Router, client components talking to the API with `credentials: include`. One three-region shell (`components/shell.tsx`), an Ask page that consumes `AskStreamEvent`s, and a context panel that renders provenance (never chain-of-thought). Shared contracts come from `@ae/domain` so the browser and server agree on shapes.

## What is deliberately not here

Kubernetes, a graph database, microservices, a message broker in the hot path, model-weight modification, and any direct provider calls from product modules.
