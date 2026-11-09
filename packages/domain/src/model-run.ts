import { z } from "zod";
import { Id, Metadata, PrivacyClass, Timestamp } from "./common.js";

/* ------------------------------------------------------------------------ */
/* Provider-neutral generation request / response                            */
/* ------------------------------------------------------------------------ */

export const ChatRole = z.enum(["system", "user", "assistant", "tool"]);
export type ChatRole = z.infer<typeof ChatRole>;

export const ChatMessage = z.object({
  role: ChatRole,
  content: z.string(),
  name: z.string().optional(),
  toolCallId: z.string().optional(),
});
export type ChatMessage = z.infer<typeof ChatMessage>;

export const ToolDefinition = z.object({
  name: z.string().min(1).max(64),
  description: z.string().max(2000),
  /** JSON Schema for the arguments. */
  parameters: z.record(z.string(), z.unknown()),
});
export type ToolDefinition = z.infer<typeof ToolDefinition>;

export const GenerationRequest = z.object({
  modelVersionId: Id,
  messages: z.array(ChatMessage).min(1),
  system: z.string().optional(),
  tools: z.array(ToolDefinition).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  stop: z.array(z.string()).optional(),
  responseFormat: z.enum(["text", "json"]).optional(),
  /** Highest privacy class of any content in `messages`. Gateway re-checks this. */
  informationPrivacyClass: PrivacyClass,
  /** Correlation: the run row created before the call. */
  modelRunId: Id,
  workspaceId: Id,
  actingIdentityId: Id,
  metadata: Metadata.optional(),
});
export type GenerationRequest = z.infer<typeof GenerationRequest>;

export const TokenUsage = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative().nullable(),
  cachedInputTokens: z.number().int().nonnegative().nullable(),
  /** True when the provider reported usage; false when estimated locally. */
  reported: z.boolean(),
});
export type TokenUsage = z.infer<typeof TokenUsage>;

/**
 * Normalized provider refusal. Adapters map provider-specific signals
 * (OpenAI `finish_reason: content_filter`, Anthropic `stop_reason: refusal`,
 * HTTP 400 policy errors) into this shape. The platform decides what to do
 * with it; it never passes refusal text through as the final answer.
 */
export const ProviderRefusal = z.object({
  /** Provider-specific code if any (e.g. "content_filter"). */
  code: z.string().nullable(),
  message: z.string().nullable(),
  /** Where the signal came from. */
  source: z.enum(["finish_reason", "stop_reason", "http_error", "response_text", "unknown"]),
  rawCategory: z.string().nullable(),
});
export type ProviderRefusal = z.infer<typeof ProviderRefusal>;

export const ProviderErrorKind = z.enum([
  "AUTHENTICATION",
  "RATE_LIMITED",
  "QUOTA_EXCEEDED",
  "INVALID_REQUEST",
  "CONTEXT_TOO_LONG",
  "PROVIDER_UNAVAILABLE",
  "TIMEOUT",
  "NETWORK",
  "UNKNOWN",
]);
export type ProviderErrorKind = z.infer<typeof ProviderErrorKind>;

export const ProviderError = z.object({
  kind: ProviderErrorKind,
  message: z.string(),
  httpStatus: z.number().int().nullable(),
  retryable: z.boolean(),
  providerRequestId: z.string().nullable(),
});
export type ProviderError = z.infer<typeof ProviderError>;

export const ToolCall = z.object({
  id: z.string(),
  name: z.string(),
  /** Raw JSON string of arguments as emitted by the provider. */
  argumentsJson: z.string(),
});
export type ToolCall = z.infer<typeof ToolCall>;

/** A citation emitted natively by a provider (e.g. Perplexity / web-grounded models). */
export const ProviderCitation = z.object({
  uri: z.string(),
  title: z.string().nullable(),
  excerpt: z.string().nullable(),
  startIndex: z.number().int().nullable(),
  endIndex: z.number().int().nullable(),
});
export type ProviderCitation = z.infer<typeof ProviderCitation>;

/**
 * Normalized streaming event vocabulary. Every adapter yields exactly these
 * so the orchestrator and UI never see provider-specific shapes.
 */
export const ModelEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("start"),
    providerRequestId: z.string().nullable(),
    modelVersionId: Id,
  }),
  z.object({ type: z.literal("delta"), text: z.string() }),
  z.object({ type: z.literal("reasoning_delta"), text: z.string() }),
  z.object({ type: z.literal("tool_call"), call: ToolCall }),
  z.object({ type: z.literal("citation"), citation: ProviderCitation }),
  z.object({ type: z.literal("usage"), usage: TokenUsage }),
  z.object({ type: z.literal("refusal"), refusal: ProviderRefusal }),
  z.object({ type: z.literal("error"), error: ProviderError }),
  z.object({
    type: z.literal("end"),
    finishReason: z.enum(["stop", "length", "tool_calls", "refusal", "error", "cancelled"]),
  }),
]);
export type ModelEvent = z.infer<typeof ModelEvent>;

export const GenerationResponse = z.object({
  modelVersionId: Id,
  text: z.string(),
  reasoningText: z.string().nullable(),
  toolCalls: z.array(ToolCall),
  citations: z.array(ProviderCitation),
  usage: TokenUsage,
  refusal: ProviderRefusal.nullable(),
  error: ProviderError.nullable(),
  finishReason: z.enum(["stop", "length", "tool_calls", "refusal", "error", "cancelled"]),
  latencyMs: z.number().int().nonnegative(),
  timeToFirstTokenMs: z.number().int().nonnegative().nullable(),
  providerRequestId: z.string().nullable(),
  estimatedCostUsd: z.number().nonnegative().nullable(),
});
export type GenerationResponse = z.infer<typeof GenerationResponse>;

export const EmbeddingRequest = z.object({
  modelVersionId: Id,
  inputs: z.array(z.string()).min(1).max(256),
  workspaceId: Id,
  actingIdentityId: Id,
  informationPrivacyClass: PrivacyClass,
});
export type EmbeddingRequest = z.infer<typeof EmbeddingRequest>;

export const EmbeddingResponse = z.object({
  modelVersionId: Id,
  vectors: z.array(z.array(z.number())),
  dimensions: z.number().int().positive(),
  usage: TokenUsage,
  latencyMs: z.number().int().nonnegative(),
  estimatedCostUsd: z.number().nonnegative().nullable(),
});
export type EmbeddingResponse = z.infer<typeof EmbeddingResponse>;

/* ------------------------------------------------------------------------ */
/* Persisted model run                                                       */
/* ------------------------------------------------------------------------ */

export const ModelRunStatus = z.enum([
  "QUEUED",
  "RUNNING",
  "SUCCEEDED",
  "REFUSED",
  "FAILED",
  "CANCELLED",
]);
export type ModelRunStatus = z.infer<typeof ModelRunStatus>;

export const ModelRunPurpose = z.enum([
  "ANSWER",
  "COMPARE",
  "SYNTHESIZE",
  "VERIFY_CLAIMS",
  "CHALLENGE",
  "EMBED",
  "CLASSIFY",
  "RESEARCH_STEP",
  "EVALUATION",
  "HEALTH_CHECK",
]);
export type ModelRunPurpose = z.infer<typeof ModelRunPurpose>;

/**
 * One call to one model. Persisted before the call starts (status RUNNING)
 * and finalized afterwards. The request snapshot is sanitized: it records
 * message ids, token counts, and parameters, never provider credentials.
 */
export const ModelRun = z.object({
  id: Id,
  workspaceId: Id,
  conversationId: Id.nullable(),
  messageId: Id.nullable(),
  modelVersionId: Id,
  providerId: Id,
  actingIdentityId: Id,
  purpose: ModelRunPurpose,
  status: ModelRunStatus,
  requestSnapshot: z.object({
    messageCount: z.number().int(),
    systemPromptHash: z.string().nullable(),
    temperature: z.number().nullable(),
    maxOutputTokens: z.number().nullable(),
    informationPrivacyClass: PrivacyClass,
    contextManifestId: Id.nullable(),
  }),
  usage: TokenUsage.nullable(),
  estimatedCostUsd: z.number().nonnegative().nullable(),
  latencyMs: z.number().int().nonnegative().nullable(),
  timeToFirstTokenMs: z.number().int().nonnegative().nullable(),
  providerRequestId: z.string().nullable(),
  refusal: ProviderRefusal.nullable(),
  error: ProviderError.nullable(),
  finishReason: z.string().nullable(),
  startedAt: Timestamp,
  finishedAt: Timestamp.nullable(),
});
export type ModelRun = z.infer<typeof ModelRun>;
