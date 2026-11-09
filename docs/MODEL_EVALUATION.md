# Model evaluation

Scores shown anywhere in the product come from `evaluation_runs` / `evaluation_results` rows produced by the harness. Nothing is estimated or typed in by hand.

## Categories and starter suites

| Category            | Suite (slug)          | What it checks today                                                                                                                                             | To add                                                                                                                                            |
| ------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Capability          | `capability-smoke`    | JSON output with typed keys, arithmetic, length constraint                                                                                                       | coding, document analysis, long-context retrieval, tool-call accuracy, citation correctness                                                       |
| Reliability         | (none yet)            |                                                                                                                                                                  | hallucination, unsupported claims, calibration, consistency, source faithfulness                                                                  |
| Behavioral latitude | `behavioral-latitude` | Professional pharmacology, security and history questions must be answered (`answer_expected`); a credential-theft request must be declined (`refusal_expected`) | ambiguous requests, more professional domains                                                                                                     |
| Security            | `security-injection`  | Indirect injection inside a source must not alter behaviour; canary secret in the system prompt must not leak                                                    | tool escalation, cross-workspace retrieval (platform-level), exfiltration                                                                         |
| Governance          | (none yet)            |                                                                                                                                                                  | identity boundary, privacy class compliance, routing compliance, audit completeness (these are platform tests in `isolation.authz.test.ts` today) |

## Graders

Deterministic: `exact_match`, `contains_all`, `contains_none`, `regex`, `json_valid`, `json_schema`, `refusal_expected`, `answer_expected`, `no_secret_leak`. `model_judge` is reserved: judge-based grading must record which model judged and is never the sole basis for approval.

## Summary metrics per run

- `weightedScore` in [0,1]
- `excessiveRefusalRate`: share of `answer_expected` cases the model declined (behavioural over-restriction)
- `missedRefusalRate`: share of `refusal_expected` cases the model answered (under-restriction)

A model with a low excessive-refusal rate but a high missed-refusal rate is **not** better; both numbers are shown together on the Model Lab screen.

## Approval rule

`POST /models/:id/status { status: "APPROVED" }` is refused (`EVALUATION_REQUIRED`) unless at least one completed run exists for the version. Platform admins decide; the decision, reason and run id are recorded append-only. Compare behaviorally modified checkpoints with their unmodified base by passing `baselineModelVersionId`.

## Running

Through the API (`POST /v1/workspaces/:ws/models/:id/evaluate { suiteSlug }`) as a platform admin; the worker executes it under the admin's workspace so spend is attributed. Starter suites are upserted by `upsertSuite()`; register them once with a small script or the API in your environment (a `pnpm eval` CLI is a roadmap item).
