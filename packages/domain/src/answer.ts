import { z } from "zod";
import { Id, Timestamp } from "./common.js";

/**
 * The answer contract. Every completed turn produces one AnswerRecord, even
 * when no answer could be produced, so the UI can state the actual result.
 */
export const AnswerDisposition = z.enum([
  "ANSWERED",
  "PARTIALLY_ANSWERED",
  "NEEDS_CLARIFICATION",
  "INSUFFICIENT_EVIDENCE",
  "AUTHORIZATION_DENIED",
  "PROVIDER_RESTRICTED",
  "UNSUPPORTED",
  "FAILED",
]);
export type AnswerDisposition = z.infer<typeof AnswerDisposition>;

export const ClaimType = z.enum([
  "SOURCED_FACT",
  "USER_PROVIDED_FACT",
  "INFERENCE",
  "RECOMMENDATION",
  "UNCERTAIN",
]);
export type ClaimType = z.infer<typeof ClaimType>;

export const CitationSourceKind = z.enum([
  "KNOWLEDGE_CHUNK",
  "KNOWLEDGE_OBJECT",
  "WEB",
  "CONVERSATION_MESSAGE",
  "PROVIDER_NATIVE",
]);
export type CitationSourceKind = z.infer<typeof CitationSourceKind>;

/**
 * A citation links answer content to something the platform can show the
 * user. `label` matches the marker used in the answer text (e.g. "S2").
 */
export const Citation = z.object({
  id: Id,
  workspaceId: Id,
  answerRecordId: Id,
  label: z.string(),
  sourceKind: CitationSourceKind,
  /** Chunk / object / message id when the source is internal. */
  sourceId: Id.nullable(),
  knowledgeObjectId: Id.nullable(),
  uri: z.string().nullable(),
  title: z.string().nullable(),
  excerpt: z.string().nullable(),
  /** Page, line range, heading, timestamp — whatever locates the excerpt. */
  locator: z.record(z.string(), z.unknown()).nullable(),
  relevanceScore: z.number().nullable(),
  /** Whether this source was actually referenced by the answer text. */
  referenced: z.boolean(),
  createdAt: Timestamp,
});
export type Citation = z.infer<typeof Citation>;

export const AnswerClaim = z.object({
  id: Id,
  answerRecordId: Id,
  workspaceId: Id,
  text: z.string(),
  claimType: ClaimType,
  citationIds: z.array(Id),
  /** Character offsets into AnswerRecord.content. */
  spanStart: z.number().int().nonnegative().nullable(),
  spanEnd: z.number().int().nonnegative().nullable(),
  confidence: z.number().min(0).max(1).nullable(),
  /** Set by the verification pass when one has run. */
  verification: z
    .object({
      status: z.enum(["UNVERIFIED", "SUPPORTED", "CONTRADICTED", "NOT_FOUND"]),
      verifierModelRunId: Id.nullable(),
      note: z.string().nullable(),
    })
    .nullable(),
});
export type AnswerClaim = z.infer<typeof AnswerClaim>;

export const AnswerLimitationKind = z.enum([
  "NO_SOURCES_RETRIEVED",
  "SOURCES_PARTIALLY_RELEVANT",
  "CLAIMS_NOT_VERIFIED",
  "MODEL_KNOWLEDGE_CUTOFF",
  "PROVIDER_REFUSED",
  "AUTHORIZATION_FILTERED_SOURCES",
  "OUTPUT_TRUNCATED",
  "CAPABILITY_UNAVAILABLE",
  "FALLBACK_MODEL_USED",
  "WEB_ACCESS_DISABLED",
  "OTHER",
]);
export type AnswerLimitationKind = z.infer<typeof AnswerLimitationKind>;

export const AnswerLimitation = z.object({
  kind: AnswerLimitationKind,
  message: z.string(),
  details: z.record(z.string(), z.unknown()).nullable(),
});
export type AnswerLimitation = z.infer<typeof AnswerLimitation>;

/** A step the platform took to produce the answer; shown as the Answer Path. */
export const AnswerPathStep = z.object({
  step: z.string(),
  detail: z.string().nullable(),
  at: Timestamp,
  durationMs: z.number().int().nonnegative().nullable(),
});
export type AnswerPathStep = z.infer<typeof AnswerPathStep>;

export const AnswerRecord = z.object({
  id: Id,
  workspaceId: Id,
  conversationId: Id,
  messageId: Id,
  actingIdentityId: Id,
  modelRunIds: z.array(Id),
  contextManifestId: Id.nullable(),

  disposition: AnswerDisposition,
  content: z.string(),

  claims: z.array(AnswerClaim),
  citations: z.array(Citation),
  /**
   * Evidence-based confidence in [0,1], or null when it cannot be computed.
   * Derived from source coverage and verification, never from the model's tone.
   */
  confidence: z.number().min(0).max(1).nullable(),
  confidenceBasis: z.string().nullable(),
  limitations: z.array(AnswerLimitation),
  answerPath: z.array(AnswerPathStep),

  createdAt: Timestamp,
});
export type AnswerRecord = z.infer<typeof AnswerRecord>;

/** Human-readable outcome statements the UI shows per disposition. */
export const DISPOSITION_STATEMENT: Record<AnswerDisposition, string> = {
  ANSWERED: "Answered.",
  PARTIALLY_ANSWERED: "Partially answered. Some aspects could not be established.",
  NEEDS_CLARIFICATION: "The question could not be reliably interpreted. Clarification is needed.",
  INSUFFICIENT_EVIDENCE: "The evidence was insufficient to support a reliable answer.",
  AUTHORIZATION_DENIED: "This information is not available in your authorized sources.",
  PROVIDER_RESTRICTED: "The selected provider declined this request.",
  UNSUPPORTED: "The required capability is not currently connected.",
  FAILED: "The request could not be completed because of a platform or provider error.",
};
