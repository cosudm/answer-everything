import type {
  EmbeddingRequest,
  EmbeddingResponse,
  GenerationRequest,
  GenerationResponse,
  ModelEvent,
  ModelHealth,
  ProviderCitation,
  ProviderError,
  ProviderRefusal,
  TokenUsage,
  ToolCall,
} from "@ae/domain";
import { metrics, type Logger } from "@ae/observability";
import { AnthropicAdapter } from "./adapters/anthropic.js";
import { OpenAiCompatibleAdapter } from "./adapters/openai-compatible.js";
import type { AdapterContext, BudgetGuard, CredentialBroker, ModelGateway, ModelResolver, ProviderAdapter } from "./types.js";
import { GatewayError } from "./types.js";
import { estimateCostUsd, estimateTokens, looksLikeTextRefusal } from "./util.js";

export interface GatewayOptions {
  resolver: ModelResolver;
  credentials: CredentialBroker;
  budget?: BudgetGuard;
  logger: Logger;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Whether LOCAL deployments may be used (false in prod). */
  allowLocalDeployments?: boolean;
}

/**
 * Default ModelGateway. Resolves the model, enforces privacy clearance and
 * budget (defense in depth: centralized authorization already checked), picks
 * the adapter by provider wire protocol, resolves credentials server-side and
 * normalizes the stream. It records telemetry but owns no database state;
 * the orchestrator persists ModelRun rows.
 */
export class DefaultModelGateway implements ModelGateway {
  private readonly adapters: Record<ProviderAdapter["kind"], ProviderAdapter> = {
    anthropic: new AnthropicAdapter(),
    "openai-compatible": new OpenAiCompatibleAdapter(),
  };

  constructor(private readonly opts: GatewayOptions) {}

  private async context(modelVersionId: string, privacyClass: string | null): Promise<AdapterContext> {
    const resolved = await this.opts.resolver.resolve(modelVersionId);
    if (!resolved) throw new GatewayError("MODEL_NOT_FOUND", `model ${modelVersionId} is not registered`);
    const { model, provider } = resolved;
    if (!model.enabled) throw new GatewayError("MODEL_DISABLED", `${model.displayName} is disabled`);
    if (!provider.enabled) throw new GatewayError("PROVIDER_DISABLED", `${provider.displayName} is disabled`);
    if (model.deploymentType === "LOCAL" && this.opts.allowLocalDeployments === false) {
      throw new GatewayError("MODEL_DISABLED", "LOCAL deployments are not permitted in this environment");
    }
    if (privacyClass && !model.privacyClassesAllowed.includes(privacyClass as never)) {
      throw new GatewayError("PRIVACY_CLASS_NOT_ALLOWED", `${model.displayName} is not cleared for ${privacyClass} information`);
    }
    if (!provider.baseUrl) throw new GatewayError("PROVIDER_UNCONFIGURED", `${provider.displayName} has no endpoint configured`);
    const apiKey = await this.opts.credentials.resolve(provider.credentialRef);
    if (provider.credentialRef && !apiKey) {
      throw new GatewayError("PROVIDER_UNCONFIGURED", `${provider.displayName} credential ${provider.credentialRef} is not configured`);
    }
    return { provider, model, apiKey, baseUrl: provider.baseUrl, fetchImpl: this.opts.fetchImpl, timeoutMs: this.opts.timeoutMs };
  }

  async *stream(request: GenerationRequest, signal?: AbortSignal): AsyncIterable<ModelEvent> {
    const ctx = await this.context(request.modelVersionId, request.informationPrivacyClass);
    if (!ctx.model.capabilities.includes("chat")) {
      throw new GatewayError("CAPABILITY_UNAVAILABLE", `${ctx.model.displayName} is not a chat model`);
    }
    if (this.opts.budget) {
      const inputEstimate = estimateTokens(request.messages.map((m) => m.content).join("\n") + (request.system ?? ""));
      const est = estimateCostUsd(ctx.model, {
        inputTokens: inputEstimate,
        outputTokens: request.maxOutputTokens ?? 1024,
        reasoningTokens: null,
        cachedInputTokens: null,
        reported: false,
      });
      const b = await this.opts.budget.check(request.workspaceId, est);
      if (!b.allowed) throw new GatewayError("BUDGET_EXCEEDED", b.reason ?? "workspace budget exceeded");
    }
    const adapter = this.adapters[ctx.provider.adapter];
    const started = Date.now();
    let firstToken: number | null = null;
    let outputChars = 0;
    let sawUsage = false;
    let finish = "stop";
    this.opts.logger.debug({ model: ctx.model.providerModelName, provider: ctx.provider.slug }, "model stream start");

    for await (const ev of adapter.stream(request, ctx, signal)) {
      if (ev.type === "delta") {
        if (firstToken === null) firstToken = Date.now() - started;
        outputChars += ev.text.length;
      }
      if (ev.type === "usage") sawUsage = true;
      if (ev.type === "end") {
        finish = ev.finishReason;
        if (!sawUsage) {
          // Provider reported nothing: estimate and flag it.
          const inputText = request.messages.map((m) => m.content).join("\n") + (request.system ?? "");
          yield {
            type: "usage",
            usage: {
              inputTokens: estimateTokens(inputText),
              outputTokens: Math.max(0, Math.ceil(outputChars / 4)),
              reasoningTokens: null,
              cachedInputTokens: null,
              reported: false,
            },
          };
        }
      }
      yield ev;
    }
    const latency = Date.now() - started;
    metrics.modelLatency.observe({ model: ctx.model.providerModelName }, latency);
    metrics.modelRuns.inc({ model: ctx.model.providerModelName, finish });
    this.opts.logger.info({ model: ctx.model.providerModelName, latencyMs: latency, ttftMs: firstToken, finish }, "model stream end");
  }

  async generate(request: GenerationRequest): Promise<GenerationResponse> {
    const started = Date.now();
    let text = "";
    let reasoning = "";
    const toolCalls: ToolCall[] = [];
    const citations: ProviderCitation[] = [];
    let usage: TokenUsage | null = null;
    let refusal: ProviderRefusal | null = null;
    let error: ProviderError | null = null;
    let finishReason: GenerationResponse["finishReason"] = "stop";
    let providerRequestId: string | null = null;
    let ttft: number | null = null;
    for await (const ev of this.stream(request)) {
      switch (ev.type) {
        case "start":
          providerRequestId = ev.providerRequestId;
          break;
        case "delta":
          if (ttft === null) ttft = Date.now() - started;
          text += ev.text;
          break;
        case "reasoning_delta":
          reasoning += ev.text;
          break;
        case "tool_call":
          toolCalls.push(ev.call);
          break;
        case "citation":
          citations.push(ev.citation);
          break;
        case "usage":
          usage = ev.usage;
          break;
        case "refusal":
          refusal = ev.refusal;
          break;
        case "error":
          error = ev.error;
          break;
        case "end":
          finishReason = ev.finishReason;
          break;
      }
    }
    if (!refusal && finishReason === "stop" && looksLikeTextRefusal(text)) {
      refusal = { code: null, message: text.slice(0, 400), source: "response_text", rawCategory: null };
      finishReason = "refusal";
    }
    const resolved = await this.opts.resolver.resolve(request.modelVersionId);
    const finalUsage = usage ?? { inputTokens: 0, outputTokens: 0, reasoningTokens: null, cachedInputTokens: null, reported: false };
    return {
      modelVersionId: request.modelVersionId,
      text,
      reasoningText: reasoning || null,
      toolCalls,
      citations,
      usage: finalUsage,
      refusal,
      error,
      finishReason,
      latencyMs: Date.now() - started,
      timeToFirstTokenMs: ttft,
      providerRequestId,
      estimatedCostUsd: resolved ? estimateCostUsd(resolved.model, finalUsage) : null,
    };
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const ctx = await this.context(request.modelVersionId, request.informationPrivacyClass);
    if (!ctx.model.capabilities.includes("embeddings")) {
      throw new GatewayError("CAPABILITY_UNAVAILABLE", `${ctx.model.displayName} is not an embedding model`);
    }
    const adapter = this.adapters[ctx.provider.adapter];
    const result = await adapter.embed(request, ctx);
    const dims = result.vectors[0]?.length ?? ctx.model.embeddingDimensions ?? 0;
    if (ctx.model.embeddingDimensions && dims !== ctx.model.embeddingDimensions) {
      throw new GatewayError(
        "CAPABILITY_UNAVAILABLE",
        `${ctx.model.displayName} returned ${dims} dimensions; registry expects ${ctx.model.embeddingDimensions}`,
      );
    }
    const usage: TokenUsage = {
      inputTokens: result.inputTokens ?? estimateTokens(request.inputs.join("\n")),
      outputTokens: 0,
      reasoningTokens: null,
      cachedInputTokens: null,
      reported: result.inputTokens != null,
    };
    metrics.modelTokens.inc({ model: ctx.model.providerModelName, direction: "input" }, usage.inputTokens);
    return {
      modelVersionId: request.modelVersionId,
      vectors: result.vectors,
      dimensions: dims,
      usage,
      latencyMs: result.latencyMs,
      estimatedCostUsd: estimateCostUsd(ctx.model, usage),
    };
  }

  async isConfigured(modelVersionId: string): Promise<{ configured: boolean; reason: string | null }> {
    try {
      await this.context(modelVersionId, null);
      return { configured: true, reason: null };
    } catch (err) {
      const e = err as GatewayError;
      return { configured: false, reason: e.message };
    }
  }

  async health(modelVersionId: string): Promise<ModelHealth> {
    const checkedAt = new Date().toISOString();
    try {
      const ctx = await this.context(modelVersionId, null);
      const r = await this.adapters[ctx.provider.adapter].health(ctx);
      return {
        modelVersionId,
        status: r.ok ? (r.latencyMs > 5000 ? "DEGRADED" : "HEALTHY") : "UNAVAILABLE",
        latencyMs: r.latencyMs,
        checkedAt,
        detail: r.detail,
      };
    } catch (err) {
      const e = err as GatewayError;
      return {
        modelVersionId,
        status: e.code === "PROVIDER_UNCONFIGURED" ? "UNCONFIGURED" : "UNAVAILABLE",
        latencyMs: null,
        checkedAt,
        detail: e.message,
      };
    }
  }
}
