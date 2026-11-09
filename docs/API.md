# API

Base URL: `API_PUBLIC_URL` (dev: `http://localhost:4000`). JSON everywhere except the two streaming endpoints (Server-Sent Events). Authentication: httpOnly cookie `ae_session` or `Authorization: Bearer <accessToken>`. All ids are UUIDs. Errors have the shape `{ error: { code, message, details?, requestId } }`.

All workspace-scoped routes live under `/v1/workspaces/:workspaceId/...` so the tenant context is explicit in the path.

## Health

| Method | Path       | Notes                                 |
| ------ | ---------- | ------------------------------------- |
| GET    | `/health`  | `{ status, env, db, embeddingModel }` |
| GET    | `/metrics` | Prometheus text format                |

## Auth

| Method | Path                | Body                                      | Notes                                                                  |
| ------ | ------------------- | ----------------------------------------- | ---------------------------------------------------------------------- |
| POST   | `/v1/auth/register` | `{ email, password, displayName }`        | 201; sets cookies; creates personal workspace. Rate limited 20/min.    |
| POST   | `/v1/auth/login`    | `{ email, password }`                     | 200; sets cookies. 401 INVALID_CREDENTIALS, 429 ACCOUNT_LOCKED.        |
| POST   | `/v1/auth/refresh`  | cookie `ae_refresh` or `{ refreshToken }` | Rotates both tokens; reuse of a rotated token revokes the chain (401). |
| POST   | `/v1/auth/logout`   |                                           | 204                                                                    |
| GET    | `/v1/auth/me`       |                                           | `{ user, actingIdentity, workspaces[] }`                               |

## Workspaces and projects

| Method   | Path                                    | Notes                                                                |
| -------- | --------------------------------------- | -------------------------------------------------------------------- |
| GET      | `/v1/workspaces`                        | Memberships of the caller                                            |
| POST     | `/v1/workspaces`                        | `{ name, kind? }`                                                    |
| GET      | `/v1/workspaces/:ws`                    | Workspace with `spend`                                               |
| PATCH    | `/v1/workspaces/:ws/settings`           | Partial `WorkspaceSettings`; ADMIN+                                  |
| GET      | `/v1/workspaces/:ws/usage`              | Month-to-date spend, tokens, runs                                    |
| GET      | `/v1/workspaces/:ws/audit?limit&before` | ADMIN+; immutable events                                             |
| GET/POST | `/v1/workspaces/:ws/projects`           | List / create `{ name, description?, instructions?, privacyClass? }` |
| GET      | `/v1/workspaces/:ws/projects/:id`       |                                                                      |

## Conversations

| Method | Path                                               | Notes                                                                                                                       |
| ------ | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/v1/workspaces/:ws/conversations?projectId&limit` |                                                                                                                             |
| POST   | `/v1/workspaces/:ws/conversations`                 | `{ projectId?, title?, modelMode?, pinnedModelVersionId? }`                                                                 |
| GET    | `/v1/workspaces/:ws/conversations/:id`             | `{ conversation, messages[], answers{ answerRecordId: AnswerRecord & { modelRuns } } }`                                     |
| DELETE | `/v1/workspaces/:ws/conversations/:id`             | Owner or ADMIN                                                                                                              |
| POST   | `/v1/workspaces/:ws/conversations/:id/messages`    | **SSE.** Body `AskInput`: `{ content, modelMode?, modelVersionId?, attachmentIds?, useKnowledge?, regenerateOfMessageId? }` |
| POST   | `/v1/workspaces/:ws/conversations/:id/compare`     | **SSE.** Body `{ content, modelVersionIds[2..4], useKnowledge? }`; events carry `lane`                                      |
| GET    | `/v1/workspaces/:ws/answers/:answerId`             | Answer record, model runs, context manifest                                                                                 |

### SSE events (`AskStreamEvent`)

`accepted { userMessage, assistantMessageId }` → `path { step, detail }`* → `context { manifest }` → `model_selected { modelVersionId, displayName, providerSlug, deploymentType, reason }` → `delta { text }`* → `notice { level, message }`* → `complete { assistantMessage, answerRecord, modelRuns }` | `error { code, message }`.

Frames are `event: <type>\ndata: <json>\n\n`; a `: ping` comment is sent every 15 s. Closing the connection aborts the model stream.

## Knowledge

| Method | Path                                                       | Notes                                                                                                                                   |
| ------ | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/v1/workspaces/:ws/knowledge?projectId&kind&search&limit` |                                                                                                                                         |
| POST   | `/v1/workspaces/:ws/knowledge/notes`                       | `CreateNoteInput`; enqueues `knowledge.ingest`                                                                                          |
| POST   | `/v1/workspaces/:ws/knowledge/upload`                      | multipart `file` + fields `title, privacyClass, aiUsePermission, projectId`; text formats are extracted, others recorded as unsupported |
| GET    | `/v1/workspaces/:ws/knowledge/:id`                         | `{ knowledge, provenance[] }`                                                                                                           |
| PATCH  | `/v1/workspaces/:ws/knowledge/:id`                         | `UpdateKnowledgeInput` (title, privacyClass, aiUsePermission, tags, projectId)                                                          |
| DELETE | `/v1/workspaces/:ws/knowledge/:id`                         | Owner or ADMIN                                                                                                                          |
| POST   | `/v1/workspaces/:ws/knowledge/search`                      | `{ query, projectId?, limit?, maxPrivacyClass? }` → hybrid hits                                                                         |

## Models

| Method | Path                                     | Notes                                                                                                                |
| ------ | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| GET    | `/v1/workspaces/:ws/models`              | `ModelSummary[]` with `configured`, `selectable`, `selectableReason`                                                 |
| GET    | `/v1/workspaces/:ws/models/:id`          | Version, provider (without credentialRef), evaluation runs, status history                                           |
| GET    | `/v1/workspaces/:ws/models/:id/health`   | Live health probe                                                                                                    |
| POST   | `/v1/workspaces/:ws/models`              | PLATFORM_ADMIN; `RegisterModelInput`; status forced to UNTESTED                                                      |
| POST   | `/v1/workspaces/:ws/models/:id/status`   | PLATFORM_ADMIN; `{ status, reason?, evaluationRunId? }`; APPROVED requires a completed run (409 EVALUATION_REQUIRED) |
| POST   | `/v1/workspaces/:ws/models/:id/enabled`  | PLATFORM_ADMIN; `{ enabled }`                                                                                        |
| POST   | `/v1/workspaces/:ws/models/:id/evaluate` | PLATFORM_ADMIN; `{ suiteSlug, baselineModelVersionId? }` → 202 job                                                   |

## Account

| Method | Path                 | Notes                                     |
| ------ | -------------------- | ----------------------------------------- |
| POST   | `/v1/account/export` | JSON download of owned workspaces         |
| POST   | `/v1/account/delete` | `{ confirmEmail }`; 202; revokes sessions |

## Error codes

`UNAUTHENTICATED` 401 · `VALIDATION` 400 · `AUTHORIZATION_DENIED` 403 (details: reasonCodes, policyIds) · `REQUIRES_APPROVAL` 409 · `NOT_FOUND` 404 · `EMAIL_TAKEN` 409 · `WEAK_PASSWORD` 400 · `INVALID_CREDENTIALS` 401 · `ACCOUNT_LOCKED` 429 · `SESSION_INVALID` 401 · `EVALUATION_REQUIRED` 409 · `BUDGET_EXCEEDED` 402 · `PROVIDER_UNCONFIGURED` 503 · `INTERNAL` 500 (quote `requestId`).

Contracts are the Zod schemas in `packages/domain/src`; the browser imports the same schemas.
