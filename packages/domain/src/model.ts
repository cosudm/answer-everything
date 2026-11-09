import { z } from "zod";
import { Id, Metadata, PrivacyClass, Timestamp } from "./common.js";

/** How a user asks for intelligence. Users pick a capability, not infrastructure. */
export const ModelMode = z.enum([
  "AUTO",
  "FRONTIER",
  "RESEARCH",
  "PRIVATE",
  "HIGH_LATITUDE",
  "EXPERIMENTAL",
]);
export type ModelMode = z.infer<typeof ModelMode>;

export const ProviderKind = z.enum([
  "ANTHROPIC",
  "OPENAI",
  "OPENAI_COMPATIBLE",
  "GOOGLE",
  "XAI",
  "DEEPSEEK",
  "PERPLEXITY",
  "AZURE_AI_FOUNDRY",
  "VLLM",
  "OLLAMA",
  "DEDICATED_INFERENCE",
  "LOCAL_DEV",
]);
export type ProviderKind = z.infer<typeof ProviderKind>;

/** Which adapter implementation speaks to the provider. */
export const AdapterKind = z.enum(["anthropic", "openai-compatible"]);
export type AdapterKind = z.infer<typeof AdapterKind>;

export const Provider = z.object({
  id: Id,
  slug: z.string().min(2).max(64),
  kind: ProviderKind,
  adapter: AdapterKind,
  displayName: z.string(),
  baseUrl: z.string().url().nullable(),
  /**
   * Name of the secret (environment variable or vault entry) holding the API
   * key. The key itself is never persisted and never leaves the server.
   */
  credentialRef: z.string().nullable(),
  /** Contractual data-handling posture, used by privacy gating. */
  dataHandling: z.object({
    trainsOnData: z.boolean(),
    retentionDays: z.number().int().nonnegative().nullable(),
    region: z.string().nullable(),
  }),
  enabled: z.boolean(),
  metadata: Metadata,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Provider = z.infer<typeof Provider>;

export const DeploymentType = z.enum(["COMMERCIAL_API", "DEDICATED_ENDPOINT", "OPEN_WEIGHT", "LOCAL"]);
export type DeploymentType = z.infer<typeof DeploymentType>;

export const BehavioralProfile = z.enum([
  "STANDARD",
  "PROFESSIONAL",
  "RESEARCH",
  "HIGH_LATITUDE",
  "EXPERIMENTAL",
]);
export type BehavioralProfile = z.infer<typeof BehavioralProfile>;

export const ModelCapability = z.enum([
  "chat",
  "streaming",
  "tools",
  "json",
  "vision",
  "long_context",
  "reasoning",
  "citations",
  "web_search",
  "embeddings",
  "code",
]);
export type ModelCapability = z.infer<typeof ModelCapability>;

export const EvaluationStatus = z.enum(["UNTESTED", "TESTING", "APPROVED", "REJECTED"]);
export type EvaluationStatus = z.infer<typeof EvaluationStatus>;

export const ModelModificationRecord = z.object({
  method: z.string(),
  version: z.string().nullable(),
  performedBy: z.string().nullable(),
  performedAt: Timestamp.nullable(),
  notes: z.string().nullable(),
});
export type ModelModificationRecord = z.infer<typeof ModelModificationRecord>;

/**
 * Every model and checkpoint is a versioned identity. A behaviorally modified
 * checkpoint (e.g. an abliterated variant hosted elsewhere) is a *separate*
 * immutable ModelVersion that records its base model, weights hash and the
 * modification method. The platform never modifies weights itself.
 */
export const ModelVersion = z.object({
  id: Id,
  providerId: Id,
  providerModelName: z.string(),
  displayName: z.string(),
  baseModel: z.string().nullable(),
  version: z.string().nullable(),
  deploymentType: DeploymentType,
  behavioralProfile: BehavioralProfile,
  capabilities: z.array(ModelCapability),
  privacyClassesAllowed: z.array(PrivacyClass),
  evaluationStatus: EvaluationStatus,
  weightsHash: z.string().nullable(),
  adapterIds: z.array(z.string()),
  contextWindow: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive().nullable(),
  /** USD per million tokens. Null when unknown; cost is then not estimated. */
  inputCostPerMillion: z.number().nonnegative().nullable(),
  outputCostPerMillion: z.number().nonnegative().nullable(),
  quantization: z.string().nullable(),
  license: z.string().nullable(),
  intendedUses: z.array(z.string()),
  prohibitedUses: z.array(z.string()),
  modificationHistory: z.array(ModelModificationRecord),
  /** Embedding dimension for embedding models. */
  embeddingDimensions: z.number().int().positive().nullable(),
  enabled: z.boolean(),
  metadata: Metadata,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type ModelVersion = z.infer<typeof ModelVersion>;

/** What the UI shows for a model: enough to choose, none of the secrets. */
export const ModelSummary = ModelVersion.pick({
  id: true,
  displayName: true,
  providerModelName: true,
  baseModel: true,
  deploymentType: true,
  behavioralProfile: true,
  capabilities: true,
  privacyClassesAllowed: true,
  evaluationStatus: true,
  contextWindow: true,
  inputCostPerMillion: true,
  outputCostPerMillion: true,
  enabled: true,
}).extend({
  provider: z.object({ slug: z.string(), displayName: z.string(), kind: ProviderKind }),
  /** Provider endpoint and credential are present (no network check). */
  configured: z.boolean(),
  /** Whether the current workspace may select this model right now, and why not if not. */
  selectable: z.boolean(),
  selectableReason: z.string().nullable(),
});
export type ModelSummary = z.infer<typeof ModelSummary>;

export const RegisterModelInput = ModelVersion.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
}).partial({
  baseModel: true,
  version: true,
  weightsHash: true,
  adapterIds: true,
  maxOutputTokens: true,
  inputCostPerMillion: true,
  outputCostPerMillion: true,
  quantization: true,
  license: true,
  intendedUses: true,
  prohibitedUses: true,
  modificationHistory: true,
  embeddingDimensions: true,
  enabled: true,
  metadata: true,
});
export type RegisterModelInput = z.infer<typeof RegisterModelInput>;

export const ModelHealth = z.object({
  modelVersionId: Id,
  status: z.enum(["HEALTHY", "DEGRADED", "UNAVAILABLE", "UNCONFIGURED"]),
  latencyMs: z.number().nullable(),
  checkedAt: Timestamp,
  detail: z.string().nullable(),
});
export type ModelHealth = z.infer<typeof ModelHealth>;
