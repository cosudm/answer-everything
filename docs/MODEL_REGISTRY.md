# Model Registry

Every model and checkpoint is a **versioned identity** (`model_versions`). A behaviorally modified checkpoint (abliterated, fine-tuned, quantized) is a separate, immutable version that records its base model, weights hash and modification method. The platform never modifies weights; it registers, evaluates, routes and governs.

## Fields preserved per version

provider · provider model name · display name · base model · version · deployment type (COMMERCIAL_API, DEDICATED_ENDPOINT, OPEN_WEIGHT, LOCAL) · behavioral profile (STANDARD, PROFESSIONAL, RESEARCH, HIGH_LATITUDE, EXPERIMENTAL) · capabilities · privacy classes allowed · evaluation status (UNTESTED → TESTING → APPROVED | REJECTED) · weights hash · adapter ids · context window · max output · pricing per million tokens · quantization · license · intended uses · prohibited uses · modification history · embedding dimensions · enabled · metadata (routing priority, approval basis).

Status transitions are append-only in `model_status_changes` with who, why and the evaluation run that justified it.

## Providers

`providers` rows name the wire adapter (`anthropic` or `openai-compatible`), the endpoint, the contractual data-handling posture and a `credentialRef`: the **name** of the secret in the environment or vault. The secret itself never enters the database.

Seeded providers: Anthropic, OpenAI (embeddings only; add chat model names when registering), DeepSeek, xAI, Perplexity, private inference (OpenAI-compatible target for vLLM / TGI / RunPod / Together / Azure ML endpoints), Ollama (dev), local-dev stub (dev).

## Registering an externally hosted open-weight or modified checkpoint

1. Deploy it behind an OpenAI-compatible endpoint (vLLM, TGI, RunPod, CoreWeave, Lambda, Together, Azure ML).
2. Set `PRIVATE_INFERENCE_BASE_URL` / `PRIVATE_INFERENCE_API_KEY` (or add a new provider row).
3. `POST /v1/workspaces/:ws/models` as a PLATFORM_ADMIN with `baseModel`, `weightsHash`, `modificationHistory: [{ method: "abliteration", version, performedBy, performedAt, notes }]`, `behavioralProfile: "EXPERIMENTAL"` or `"HIGH_LATITUDE"`, `deploymentType: "DEDICATED_ENDPOINT"`. The API forces `evaluationStatus: "UNTESTED"` regardless of input.
4. It is now visible only to workspaces with `allowExperimentalModels: true`, shown as Experimental, and never chosen by Auto for other workspaces.
5. Run the harness: `POST /v1/workspaces/:ws/models/:id/evaluate { suiteSlug }` for each suite, ideally with `baselineModelVersionId` set to the unmodified base so results can be compared.
6. Approve with `POST .../status { status: "APPROVED", evaluationRunId }`. Approval is refused without at least one completed run. Reduced refusal is never, on its own, grounds for approval (MODEL_EVALUATION.md).

## Routing (Auto)

`routeModels()` in `@ae/model-registry`:

- **Hard filters**: configured (credential + endpoint present), enabled, chat-capable, not REJECTED, approved or workspace opted in, commercial allowed, cleared for the information privacy class, mode profile match (PRIVATE excludes commercial APIs; EXPERIMENTAL and HIGH_LATITUDE modes select those profiles only), required capabilities, context window, budget.
- **Ranking**: approved first; mode affinity (research → citations/web_search/long_context; auto/frontier → reasoning); cost weight (economy preference for short questions); `metadata.routingPriority`.
- **Explainability**: the chosen reason and every exclusion reason are returned and shown in the Answer Path.

Centralized authorization re-checks the final choice (`model.use`) for the exact information class before the run starts. Routing never widens authority.
