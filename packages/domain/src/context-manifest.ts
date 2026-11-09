import { z } from "zod";
import { Id, PrivacyClass, Timestamp } from "./common.js";

/**
 * The strategy Auto mode chose for a turn. Expensive strategies are only
 * selected when the question warrants them.
 */
export const AnswerStrategy = z.enum([
  "DIRECT",
  "RETRIEVAL_AUGMENTED",
  "INTERNAL_KNOWLEDGE",
  "WEB_RESEARCH",
  "MULTI_MODEL_COMPARISON",
  "CRITIC_AND_REVISER",
  "LONG_RUNNING_RESEARCH",
  "CODE_EXECUTION",
  "DOCUMENT_ANALYSIS",
  "REFUSAL_REVIEW",
  "HUMAN_APPROVAL",
]);
export type AnswerStrategy = z.infer<typeof AnswerStrategy>;

export const ContextItemKind = z.enum([
  "SYSTEM_INSTRUCTION",
  "PROJECT_INSTRUCTION",
  "CONVERSATION_MESSAGE",
  "KNOWLEDGE_CHUNK",
  "ATTACHMENT",
  "MEMORY",
  "WEB_RESULT",
  "TOOL_RESULT",
]);
export type ContextItemKind = z.infer<typeof ContextItemKind>;

/**
 * One piece of information that was considered for the model's context.
 * `included=false` items were retrieved/considered but dropped (budget,
 * authorization, relevance) and are kept so the Answer Path can explain
 * exactly what the model did and did not see.
 */
export const ContextManifestItem = z.object({
  id: Id,
  kind: ContextItemKind,
  /** Reference to the underlying record (chunk id, message id, ...). */
  refId: Id.nullable(),
  knowledgeObjectId: Id.nullable(),
  /** Stable label used in prompts and citations, e.g. "S1". */
  label: z.string().nullable(),
  privacyClass: PrivacyClass,
  tokens: z.number().int().nonnegative(),
  rank: z.number().int().nonnegative().nullable(),
  score: z.number().nullable(),
  included: z.boolean(),
  reason: z.string(),
  /** Authorization decision that allowed or blocked this item, if one was recorded. */
  authorizationDecisionId: Id.nullable(),
});
export type ContextManifestItem = z.infer<typeof ContextManifestItem>;

/**
 * Immutable record of what information was assembled for a model run and why.
 * Built *after* authorization filtering: nothing unauthorized is ever
 * retrieved and then dropped.
 */
export const ContextManifest = z.object({
  id: Id,
  workspaceId: Id,
  conversationId: Id.nullable(),
  messageId: Id.nullable(),
  actingIdentityId: Id,
  strategy: AnswerStrategy,
  /** Highest privacy class of any included item. Drives model eligibility. */
  informationPrivacyClass: PrivacyClass,
  tokenBudget: z.number().int().positive(),
  tokensUsed: z.number().int().nonnegative(),
  items: z.array(ContextManifestItem),
  retrieval: z
    .object({
      query: z.string(),
      candidates: z.number().int().nonnegative(),
      used: z.number().int().nonnegative(),
      method: z.enum(["hybrid", "lexical", "vector", "none"]),
    })
    .nullable(),
  createdAt: Timestamp,
});
export type ContextManifest = z.infer<typeof ContextManifest>;
