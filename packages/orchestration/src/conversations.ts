import type { Queryable } from "@ae/database";
import { iso, isoRequired } from "@ae/database";
import type {
  Attachment,
  Conversation,
  Message,
  MessageRole,
  MessageStatus,
  ModelMode,
  PrivacyClass,
} from "@ae/domain";

export function toConversation(r: Record<string, unknown>): Conversation {
  return {
    id: r.id as string,
    workspaceId: r.workspace_id as string,
    projectId: (r.project_id as string | null) ?? null,
    createdByUserId: r.created_by_user_id as string,
    title: (r.title as string | null) ?? null,
    privacyClass: r.privacy_class as PrivacyClass,
    modelMode: r.model_mode as ModelMode,
    pinnedModelVersionId: (r.pinned_model_version_id as string | null) ?? null,
    parentConversationId: (r.parent_conversation_id as string | null) ?? null,
    branchedFromMessageId: (r.branched_from_message_id as string | null) ?? null,
    messageCount: Number(r.message_count ?? 0),
    lastMessageAt: iso(r.last_message_at as string | null),
    createdAt: isoRequired(r.created_at as string),
    updatedAt: isoRequired(r.updated_at as string),
    deletedAt: iso(r.deleted_at as string | null),
  };
}

export function toMessage(r: Record<string, unknown>): Message {
  return {
    id: r.id as string,
    conversationId: r.conversation_id as string,
    workspaceId: r.workspace_id as string,
    role: r.role as MessageRole,
    content: r.content as string,
    contentFormat: r.content_format as Message["contentFormat"],
    actingIdentityId: r.acting_identity_id as string,
    parentMessageId: (r.parent_message_id as string | null) ?? null,
    sequence: Number(r.sequence),
    status: r.status as MessageStatus,
    attachments: (r.attachments as Attachment[]) ?? [],
    answerRecordId: (r.answer_record_id as string | null) ?? null,
    metadata: (r.metadata as Record<string, unknown>) ?? {},
    createdAt: isoRequired(r.created_at as string),
  };
}

export async function createConversation(
  q: Queryable,
  input: {
    workspaceId: string;
    projectId: string | null;
    createdByUserId: string;
    title: string | null;
    privacyClass: PrivacyClass;
    modelMode: ModelMode;
    pinnedModelVersionId: string | null;
    parentConversationId?: string | null;
    branchedFromMessageId?: string | null;
  },
): Promise<Conversation> {
  const res = await q.query(
    `INSERT INTO conversations
       (workspace_id, project_id, created_by_user_id, title, privacy_class, model_mode, pinned_model_version_id,
        parent_conversation_id, branched_from_message_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [
      input.workspaceId,
      input.projectId,
      input.createdByUserId,
      input.title,
      input.privacyClass,
      input.modelMode,
      input.pinnedModelVersionId,
      input.parentConversationId ?? null,
      input.branchedFromMessageId ?? null,
    ],
  );
  return toConversation(res.rows[0]);
}

export async function getConversation(q: Queryable, id: string): Promise<Conversation | null> {
  const res = await q.query("SELECT * FROM conversations WHERE id = $1 AND deleted_at IS NULL", [
    id,
  ]);
  return res.rows[0] ? toConversation(res.rows[0]) : null;
}

export async function listConversations(
  q: Queryable,
  workspaceId: string,
  opts: { projectId?: string | null; limit?: number } = {},
): Promise<Conversation[]> {
  const res = await q.query(
    `SELECT * FROM conversations WHERE workspace_id = $1 AND deleted_at IS NULL AND ($2::uuid IS NULL OR project_id = $2)
     ORDER BY COALESCE(last_message_at, created_at) DESC LIMIT $3`,
    [workspaceId, opts.projectId ?? null, Math.min(opts.limit ?? 50, 200)],
  );
  return res.rows.map(toConversation);
}

export async function updateConversation(
  q: Queryable,
  id: string,
  patch: {
    title?: string | null;
    privacyClass?: PrivacyClass;
    modelMode?: ModelMode;
    pinnedModelVersionId?: string | null;
  },
): Promise<Conversation | null> {
  const res = await q.query(
    `UPDATE conversations SET
       title = CASE WHEN $2::boolean THEN $3 ELSE title END,
       privacy_class = COALESCE($4, privacy_class),
       model_mode = COALESCE($5, model_mode),
       pinned_model_version_id = CASE WHEN $6::boolean THEN $7::uuid ELSE pinned_model_version_id END
     WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
    [
      id,
      patch.title !== undefined,
      patch.title ?? null,
      patch.privacyClass ?? null,
      patch.modelMode ?? null,
      patch.pinnedModelVersionId !== undefined,
      patch.pinnedModelVersionId ?? null,
    ],
  );
  return res.rows[0] ? toConversation(res.rows[0]) : null;
}

export async function softDeleteConversation(q: Queryable, id: string): Promise<boolean> {
  const res = await q.query(
    "UPDATE conversations SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL",
    [id],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function listMessages(
  q: Queryable,
  conversationId: string,
  opts: { limit?: number } = {},
): Promise<Message[]> {
  const res = await q.query(
    `SELECT * FROM (SELECT * FROM messages WHERE conversation_id = $1 ORDER BY sequence DESC LIMIT $2) m ORDER BY sequence ASC`,
    [conversationId, Math.min(opts.limit ?? 200, 500)],
  );
  return res.rows.map(toMessage);
}

export async function getMessage(q: Queryable, id: string): Promise<Message | null> {
  const res = await q.query("SELECT * FROM messages WHERE id = $1", [id]);
  return res.rows[0] ? toMessage(res.rows[0]) : null;
}

/** Appends a message with the next sequence number and bumps conversation counters. */
export async function appendMessage(
  q: Queryable,
  input: {
    conversationId: string;
    workspaceId: string;
    role: MessageRole;
    content: string;
    actingIdentityId: string;
    parentMessageId: string | null;
    status: MessageStatus;
    attachments?: Attachment[];
    metadata?: Record<string, unknown>;
  },
): Promise<Message> {
  // Serialize appends per conversation.
  await q.query("SELECT 1 FROM conversations WHERE id = $1 FOR UPDATE", [input.conversationId]);
  const res = await q.query(
    `INSERT INTO messages
       (conversation_id, workspace_id, role, content, acting_identity_id, parent_message_id, sequence, status, attachments, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,
             (SELECT COALESCE(MAX(sequence), -1) + 1 FROM messages WHERE conversation_id = $1),
             $7,$8,$9)
     RETURNING *`,
    [
      input.conversationId,
      input.workspaceId,
      input.role,
      input.content,
      input.actingIdentityId,
      input.parentMessageId,
      input.status,
      JSON.stringify(input.attachments ?? []),
      JSON.stringify(input.metadata ?? {}),
    ],
  );
  await q.query(
    `UPDATE conversations SET message_count = message_count + 1, last_message_at = now(),
       title = COALESCE(title, CASE WHEN $2 = 'USER' THEN left(regexp_replace($3, '\\s+', ' ', 'g'), 80) END)
     WHERE id = $1`,
    [input.conversationId, input.role, input.content],
  );
  return toMessage(res.rows[0]);
}

export async function finalizeMessage(
  q: Queryable,
  id: string,
  patch: {
    content: string;
    status: MessageStatus;
    answerRecordId: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<Message> {
  const res = await q.query(
    `UPDATE messages SET content = $2, status = $3, answer_record_id = $4, metadata = metadata || $5::jsonb WHERE id = $1 RETURNING *`,
    [id, patch.content, patch.status, patch.answerRecordId, JSON.stringify(patch.metadata ?? {})],
  );
  return toMessage(res.rows[0]);
}
