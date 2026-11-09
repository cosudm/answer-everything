# Roadmap

Ordered by the delivery sequence in the project brief, adjusted for what the MVP already contains.

## Done in this build

Repository architecture · authentication and workspace identity (local) · schema and migrations · Model Gateway and Registry · Ask with streaming · conversation persistence · knowledge ingestion (text) · governed retrieval · citations and provenance · Auto routing (deterministic) · model comparison · evaluation harness (starter) · IGL authorization · experimental open-weight provider adapter path · cost controls · DEV/UAT/PROD skeletons.

## Next: make the signature interactions real

1. **Verification pass** (`answer.verify_claims` job): a second model run extracts material claims, checks each against retrieved sources, marks SUPPORTED / CONTRADICTED / NOT_FOUND, and upgrades UNCERTAIN → INFERENCE where reasoning is sound. Unlocks honest confidence beyond coverage.
2. **Go Deeper**: expand an existing answer in place: more sources (wider retrieval), other models (Compare on the same manifest), disagreements (diff of lane claims), evidence check (verification pass), deeper synthesis (critic-and-reviser strategy). One button, one growing answer record chain.
3. **Challenge This**: adversarial pass that tries to disprove the answer: extract claims, search for contradicting evidence, list weak assumptions, propose alternative explanations, revise if warranted. Uses a different model where available.
4. **Research execution**: worker runs `research_tasks` steps (plan → sources → evidence → contradictions → claims → verify → synthesize) with live progress events; web research strategy behind `webAccessEnabled`.

## Platform hardening

5. OIDC / OAuth 2.1 (Entra External ID, Auth0, Clerk) and MFA enforcement; organization workspaces with invitations.
6. Object storage adapter (Blob/S3) with signed URLs; malware scanning; PDF/DOCX/PPTX extraction in the worker.
7. Account purge job, retention sweep, asynchronous export with signed download.
8. Service Bus / SQS `JobQueue` adapter; model health-check job feeding the Models screen.
9. OpenTelemetry SDK bootstrap with OTLP exporter; Sentry; CSP for the web app.
10. Budget reservations (fix the check-then-run race); per-model rate limits.

## Intelligence

11. Model-assisted question classification for Auto; multi-model synthesis (evidence over consensus).
12. Google (Gemini) adapter; Azure AI Foundry endpoint support; vLLM/TGI reference deployment for open-weight checkpoints.
13. Richer evaluation suites per category; model-judge grader with recorded judge; baseline comparison views in Model Lab.
14. Confirmed memory (opt-in), saved answers as knowledge, reusable answer templates, share links.

## Explicitly out of scope

Public social feed, generalized autonomous agents, unrestricted code execution, customer-uploaded arbitrary checkpoints, automatic weight modification, marketplace, cryptocurrency, complex enterprise billing, mobile-native apps, Kubernetes unless inference deployment requires it.
