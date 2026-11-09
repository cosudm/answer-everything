import type {
  EmbeddingRequest,
  EmbeddingResponse,
  GenerationRequest,
  GenerationResponse,
  ModelEvent,
  ModelHealth,
  ModelVersion,
  Provider,
} from "@ae/domain";

/**
 * The provider-neutral gateway. No product module calls a provider directly;
 * everything goes through here so that credentials, privacy gating, budget
 * checks, telemetry and normalization happen in one place.
 */
export interface ModelGateway {
  generate(request: GenerationRequest): Promise<GenerationResponse>;
  stream(request: GenerationRequest, signal?: AbortSignal): AsyncIterable<ModelEvent>;
  embed(request: EmbeddingRequest): Promise<EmbeddingResponse>;
  health(modelVersionId: string): Promise<ModelHealth>;
  /**
   * Whether the model can be called right now: enabled, provider enabled,
   * endpoint present and credential resolvable. No network call. Routing
   * uses this so unconfigured providers never consume fallback attempts.
   */
  isConfigured(modelVersionId: string): Promise<{ configured: boolean; reason: string | null }>;
}

/** Everything an adapter needs to talk to one provider for one call. */
export interface AdapterContext {
  provider: Provider;
  model: ModelVersion;
  /** Resolved secret, or null for providers that need none. Never logged. */
  apiKey: string | null;
  baseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * One adapter per wire protocol. Adapters normalize provider shapes into the
 * ModelEvent vocabulary and never throw for provider-side problems: they
 * yield an `error` or `refusal` event and then `end`.
 */
export interface ProviderAdapter {
  readonly kind: "anthropic" | "openai-compatible";
  stream(
    request: GenerationRequest,
    ctx: AdapterContext,
    signal?: AbortSignal,
  ): AsyncIterable<ModelEvent>;
  embed(
    request: EmbeddingRequest,
    ctx: AdapterContext,
  ): Promise<{ vectors: number[][]; inputTokens: number | null; latencyMs: number }>;
  health(ctx: AdapterContext): Promise<{ ok: boolean; latencyMs: number; detail: string | null }>;
}

/**
 * Resolves `credentialRef` names to secrets. The environment implementation
 * reads process.env; deployments swap in Key Vault / Secrets Manager. Secrets
 * never enter model context, logs, the database or the browser.
 */
export interface CredentialBroker {
  resolve(credentialRef: string | null): Promise<string | null>;
}

export interface ModelResolver {
  resolve(modelVersionId: string): Promise<{ model: ModelVersion; provider: Provider } | null>;
}

/** Budget guard consulted before each run. */
export interface BudgetGuard {
  check(
    workspaceId: string,
    estimatedCostUsd: number | null,
  ): Promise<{ allowed: boolean; remainingUsd: number | null; reason: string | null }>;
}

export class GatewayError extends Error {
  constructor(
    public readonly code:
      | "MODEL_NOT_FOUND"
      | "MODEL_DISABLED"
      | "PROVIDER_DISABLED"
      | "PROVIDER_UNCONFIGURED"
      | "PRIVACY_CLASS_NOT_ALLOWED"
      | "BUDGET_EXCEEDED"
      | "CAPABILITY_UNAVAILABLE",
    message: string,
  ) {
    super(message);
  }
}
