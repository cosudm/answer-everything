# Status

Running record of implementation status, test results, open risks, security findings, deferred work and provider limitations. Updated with every material change. Last updated: 2026-11-08.

## Implementation status

| Area                           | State                | Notes                                                                                                                                                                                                                                            |
| ------------------------------ | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Repository architecture        | Done                 | pnpm workspaces, 14 packages, 3 apps, 1 tool. Typecheck, lint, format, tests wired at the root.                                                                                                                                                  |
| Database schema and migrations | Done                 | 8 SQL migrations, pgvector, checksum-tracked runner, two application roles, RLS on every tenant table.                                                                                                                                           |
| Identity                       | Done (local)         | Registration, scrypt passwords, opaque HMAC-hashed sessions, rotating refresh tokens with reuse detection, lockout, personal workspace at sign-up. OIDC federation and MFA enforcement: not started (interfaces reserved).                       |
| Centralized authorization      | Done                 | Deny-by-default policy engine with 13 policies, DB-backed facts loader, decisions and denials persisted in their own transaction and audited.                                                                                                    |
| Model Gateway                  | Done                 | Provider-neutral interface; OpenAI-compatible and Anthropic adapters normalize streaming, usage, refusals, errors, citations, tool calls; credential broker; budget guard; `isConfigured` for routing.                                           |
| Model Registry                 | Done                 | Versioned model identities with provenance fields, seed file, status transitions recorded, evaluation-gated approval.                                                                                                                            |
| Auto routing                   | Done (deterministic) | Eligibility filters + ranking per mode; question classifier is heuristic (no model call).                                                                                                                                                        |
| Ask vertical slice             | Done                 | Sign-in → conversation → context manifest → model → SSE stream → answer record with citations, claims, limitations, answer path, model runs, cost ledger.                                                                                        |
| Compare                        | Done                 | 2–4 models in parallel lanes; one answer record per lane.                                                                                                                                                                                        |
| Knowledge ingestion            | Done (text formats)  | Notes and text/markdown/csv/html/json uploads: extract → chunk → embed → index with provenance. PDF/DOCX extraction and malware scanning: not connected (recorded as FAILED/unsupported, never silently indexed).                                |
| Governed retrieval             | Done                 | Hybrid lexical + vector search with reciprocal rank fusion; privacy ceiling, AI-use permission, READY status and project scope enforced inside SQL.                                                                                              |
| Citations and provenance       | Done                 | Citations linked to chunks; claims classified by citation coverage; provenance records for extraction, embedding, indexing, generation and citation.                                                                                             |
| Evaluation harness             | Done (starter)       | Deterministic graders, runner, three starter suites, results persisted; approval requires a completed run. Model-judge grading not implemented.                                                                                                  |
| Cost and token telemetry       | Done                 | Per-run usage, estimated cost (null when pricing unknown), ledger, monthly budget guard, Prometheus metrics.                                                                                                                                     |
| Audit trail                    | Done                 | Append-only `audit_events` (DB trigger), written for auth, workspace, knowledge, model-run and denial events.                                                                                                                                    |
| Data export / deletion         | Done (MVP)           | Synchronous JSON export of owned workspaces; deletion marks `PENDING_DELETION`, revokes sessions, enqueues `account.delete` (purge handler not yet implemented).                                                                                 |
| Web application                | Done (slice)         | Premium light shell, Ask with streaming and citation chips, context panel (Sources, Models, Evidence, Knowledge, Answer path, Details), Knowledge, Projects, Models and Model detail, Controls, History.                                         |
| Research mode                  | Contracts only       | Task/step contracts, planner and table exist; worker execution not implemented. UI states this plainly.                                                                                                                                          |
| Go Deeper / Challenge This     | Not started          | Not rendered in the UI so nothing claims to exist that does not.                                                                                                                                                                                 |
| Infrastructure                 | Skeletons            | Dockerfiles, docker-compose, Terraform module + dev/uat/prod stacks (Azure Container Apps, PostgreSQL Flexible Server, Key Vault, Blob, Service Bus, App Insights), GitHub Actions CI. Not applied to a real subscription from this environment. |

## Test results (latest run, 2026-11-08)

```
Unit            73 passed   (policy, routing, adapters, SSE, claims, chunking, graders, passwords)
Integration     11 passed   (API: auth lifecycle, refresh rotation, ask with citations, fallback, refusal, unconfigured, compare, export/delete, metrics)
Authorization   21 passed   (10 RLS proofs as the ae_app role; 11 API isolation proofs)
Total          106 passed, 0 failed, 0 skipped when DATABASE_URL is set
Browser smoke    8 steps passed (register, note, ask, panel, refusal, models, settings, mobile) via Playwright
Production build API, worker and web bundles build and start
```

Bugs found and fixed by the tests during the build: refresh-token-reuse revocation rolled back with the thrown error; denial records rolled back with the caller's transaction; `RETURNING` under RLS for non-members; chunker heading attribution; citation markers split from their sentence; service identity removed by test truncation.

## Open risks

1. **No OIDC yet.** Local passwords are production-grade (scrypt, lockout, rotation) but enterprise sign-in (Entra External ID / Auth0 / Clerk) is not wired. Interfaces (`IdentityProviderConfig`, `Principal`) are in place.
2. **Claim verification is coverage-based, not evidence-checked.** Uncited sentences are labelled "not traced to a source"; the critic/verifier pass that would upgrade or contradict them is on the roadmap. The UI and `confidenceBasis` say this explicitly.
3. **Auto routing's question classifier is heuristic.** It never calls a model; it will misjudge some questions as "trivial". Model-assisted classification is a roadmap item.
4. **Provider refusal detection in plain text is conservative by design**; a provider that refuses with a long explanation will be recorded as ANSWERED.
5. **Budget guard races.** Two concurrent runs can both pass the check and jointly exceed the ceiling by at most one run's estimate. Acceptable for MVP; a reservation row is the fix.
6. **Upload originals are stored in PostgreSQL (`text_content`), not object storage.** Blob storage is provisioned in Terraform; the storage adapter is not written.
7. **Malware scanning is not performed** on uploads. Recorded in the pipeline as a deferred step; only text formats are accepted today.

## Security findings

- No cross-workspace or cross-identity exposure found by the 21 authorization proofs. (Release threshold: zero known.)
- Provider credentials never enter the database, logs (pino redaction), model context or API responses (`credentialRef` is stripped from the model detail endpoint, and tests assert it).
- Audit, provenance, decision and model-status tables reject UPDATE/DELETE for every role including the owner.
- Dev-only toggles (`AE_DEFAULT_ALLOW_EXPERIMENTAL`, insecure cookies, placeholder session secret, LOCAL deployments) make the API refuse to start when `AE_ENV=prod`.

## Deferred work (see ROADMAP.md)

Research execution, Go Deeper, Challenge This, verification pass, OIDC, MFA, PDF/DOCX extraction, malware scan, object storage adapter, Service Bus queue adapter, account purge job, retention sweep, share links, organization invitations, model-judge graders, health-check job, web research strategy.

## Model-provider limitations

- Anthropic, OpenAI, DeepSeek, xAI, Perplexity and private inference adapters are implemented against their documented wire protocols and tested against protocol-faithful fake servers. They have **not** been exercised against live endpoints from this build environment (no outbound network to providers here). First live run should be done with `pnpm eval` against a cheap model and the gateway logs reviewed.
- OpenAI chat model names are intentionally not seeded; add current identifiers to `config/models.seed.json`.
- Pricing is seeded only where stated in the project brief (Claude Fable 5.1). Other models show "pricing unknown" and cost is not estimated until prices are entered.
- The local development provider is a labelled stub. It proves the pipeline; it does not answer questions.
