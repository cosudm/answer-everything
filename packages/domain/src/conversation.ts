import { z } from "zod";
import { Id, Metadata, PrivacyClass, Timestamp } from "./common.js";
import { ModelMode } from "./model.js";

export const Conversation = z.object({
  id: Id,
  workspaceId: Id,
  projectId: Id.nullable(),
  createdByUserId: Id,
  title: z.string().max(200).nullable(),
  /** Highest privacy class of anything that has entered the conversation. */
  privacyClass: PrivacyClass,
  modelMode: ModelMode,
  /** When a user pins a specific model instead of a mode. */
  pinnedModelVersionId: Id.nullable(),
  /** Branching: this conversation forked from a message in another one. */
  parentConversationId: Id.nullable(),
  branchedFromMessageId: Id.nullable(),
  messageCount: z.number().int().nonnegative(),
  lastMessageAt: Timestamp.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  deletedAt: Timestamp.nullable(),
});
export type Conversation = z.infer<typeof Conversation>;

export const MessageRole = z.enum(["USER", "ASSISTANT", "SYSTEM", "TOOL"]);
export type MessageRole = z.infer<typeof MessageRole>;

export const MessageStatus = z.enum(["COMPLETE", "STREAMING", "FAILED", "CANCELLED"]);
export type MessageStatus = z.infer<typeof MessageStatus>;

export const Attachment = z.object({
  knowledgeObjectId: Id,
  title: z.string(),
  mimeType: z.string(),
  byteSize: z.number().int().nonnegative(),
});
export type Attachment = z.infer<typeof Attachment>;

export const Message = z.object({
  id: Id,
  conversationId: Id,
  workspaceId: Id,
  role: MessageRole,
  content: z.string(),
  contentFormat: z.enum(["markdown", "text"]),
  actingIdentityId: Id,
  /** Which assistant message this user message replies to, or which user message an answer responds to. */
  parentMessageId: Id.nullable(),
  sequence: z.number().int().nonnegative(),
  status: MessageStatus,
  attachments: z.array(Attachment),
  /** For ASSISTANT messages: the answer record carrying provenance. */
  answerRecordId: Id.nullable(),
  metadata: Metadata,
  createdAt: Timestamp,
});
export type Message = z.infer<typeof Message>;

export const CreateConversationInput = z.object({
  projectId: Id.optional(),
  title: z.string().max(200).optional(),
  modelMode: ModelMode.default("AUTO"),
  pinnedModelVersionId: Id.optional(),
});
export type CreateConversationInput = z.infer<typeof CreateConversationInput>;

export const AskInput = z.object({
  content: z.string().min(1).max(60_000),
  modelMode: ModelMode.optional(),
  modelVersionId: Id.optional(),
  /** Knowledge objects to pull into context for this turn. */
  attachmentIds: z.array(Id).max(20).optional(),
  /** Use workspace/project knowledge retrieval for this turn. */
  useKnowledge: z.boolean().default(true),
  /** Regenerate: re-answer the given user message instead of appending. */
  regenerateOfMessageId: Id.optional(),
});
export type AskInput = z.infer<typeof AskInput>;

export const CompareInput = z.object({
  content: z.string().min(1).max(60_000),
  modelVersionIds: z.array(Id).min(2).max(4),
  useKnowledge: z.boolean().default(true),
});
export type CompareInput = z.infer<typeof CompareInput>;
