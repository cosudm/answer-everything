import { z } from "zod";
import { Id, Metadata, PrivacyClass, Timestamp } from "./common.js";

export const KnowledgeKind = z.enum([
  "DOCUMENT",
  "NOTE",
  "SAVED_ANSWER",
  "CONVERSATION",
  "SOURCE",
  "MEMORY",
  "RESEARCH",
]);
export type KnowledgeKind = z.infer<typeof KnowledgeKind>;

export const KnowledgeStatus = z.enum([
  "PENDING",
  "SCANNING",
  "EXTRACTING",
  "INDEXING",
  "READY",
  "FAILED",
  "ARCHIVED",
]);
export type KnowledgeStatus = z.infer<typeof KnowledgeStatus>;

/** Whether models may read this object at all. Authorization enforces it before retrieval. */
export const AiUsePermission = z.enum(["ALLOW", "DENY"]);
export type AiUsePermission = z.infer<typeof AiUsePermission>;

/**
 * A governed knowledge object: a document, note, saved answer, confirmed
 * memory, research collection or external source. Every object carries
 * ownership, privacy class, provenance and explicit AI-use permission.
 */
export const KnowledgeObject = z.object({
  id: Id,
  workspaceId: Id,
  projectId: Id.nullable(),
  kind: KnowledgeKind,
  title: z.string().min(1).max(300),
  mimeType: z.string().nullable(),
  byteSize: z.number().int().nonnegative().nullable(),
  /** SHA-256 of the original bytes, for integrity and dedupe. */
  contentHash: z.string().nullable(),
  /** Object storage key of the original. Never a public URL. */
  storageKey: z.string().nullable(),
  /** Where it came from (upload filename, URL, conversation id). */
  sourceUri: z.string().nullable(),
  privacyClass: PrivacyClass,
  aiUsePermission: AiUsePermission,
  status: KnowledgeStatus,
  statusDetail: z.string().nullable(),
  ownerUserId: Id,
  tags: z.array(z.string().max(60)).max(50),
  chunkCount: z.number().int().nonnegative(),
  metadata: Metadata,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  archivedAt: Timestamp.nullable(),
  deletedAt: Timestamp.nullable(),
});
export type KnowledgeObject = z.infer<typeof KnowledgeObject>;

export const KnowledgeChunk = z.object({
  id: Id,
  knowledgeObjectId: Id,
  workspaceId: Id,
  ordinal: z.number().int().nonnegative(),
  content: z.string(),
  tokenCount: z.number().int().nonnegative(),
  /** Heading path / page / line hints for locating the chunk in the original. */
  locator: z.record(z.string(), z.unknown()).nullable(),
  embeddingModelVersionId: Id.nullable(),
  createdAt: Timestamp,
});
export type KnowledgeChunk = z.infer<typeof KnowledgeChunk>;

export const SearchHit = z.object({
  chunkId: Id,
  knowledgeObjectId: Id,
  title: z.string(),
  content: z.string(),
  privacyClass: PrivacyClass,
  locator: z.record(z.string(), z.unknown()).nullable(),
  /** Fused score (reciprocal rank fusion of lexical + vector ranks). */
  score: z.number(),
  lexicalRank: z.number().int().nullable(),
  vectorRank: z.number().int().nullable(),
});
export type SearchHit = z.infer<typeof SearchHit>;

export const CreateNoteInput = z.object({
  title: z.string().min(1).max(300),
  content: z.string().min(1).max(500_000),
  projectId: Id.optional(),
  privacyClass: PrivacyClass.optional(),
  tags: z.array(z.string().max(60)).max(50).optional(),
  aiUsePermission: AiUsePermission.default("ALLOW"),
});
export type CreateNoteInput = z.infer<typeof CreateNoteInput>;

export const UpdateKnowledgeInput = z.object({
  title: z.string().min(1).max(300).optional(),
  privacyClass: PrivacyClass.optional(),
  aiUsePermission: AiUsePermission.optional(),
  tags: z.array(z.string().max(60)).max(50).optional(),
  projectId: Id.nullable().optional(),
});
export type UpdateKnowledgeInput = z.infer<typeof UpdateKnowledgeInput>;

export const KnowledgeSearchInput = z.object({
  query: z.string().min(1).max(2000),
  projectId: Id.optional(),
  limit: z.number().int().min(1).max(50).default(10),
  maxPrivacyClass: PrivacyClass.optional(),
});
export type KnowledgeSearchInput = z.infer<typeof KnowledgeSearchInput>;
