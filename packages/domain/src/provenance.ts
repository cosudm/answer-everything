import { z } from "zod";
import { Id, Metadata, Timestamp } from "./common.js";

/**
 * Provenance answers "where did this come from and what happened to it".
 * It is distinct from the security audit log: provenance is about
 * information lineage; audit is about who did what.
 */
export const ProvenanceEventKind = z.enum([
  "CREATED",
  "UPLOADED",
  "EXTRACTED",
  "CLASSIFIED",
  "CHUNKED",
  "EMBEDDED",
  "INDEXED",
  "DERIVED_FROM",
  "CITED_BY",
  "RETRIEVED_FOR",
  "GENERATED_BY_MODEL",
  "VERIFIED",
  "EXPORTED",
  "ARCHIVED",
  "DELETED",
  "PRIVACY_CHANGED",
]);
export type ProvenanceEventKind = z.infer<typeof ProvenanceEventKind>;

export const ProvenanceSubjectKind = z.enum([
  "KNOWLEDGE_OBJECT",
  "KNOWLEDGE_CHUNK",
  "MESSAGE",
  "ANSWER_RECORD",
  "CITATION",
  "CONTEXT_MANIFEST",
  "MODEL_RUN",
  "RESEARCH_TASK",
]);
export type ProvenanceSubjectKind = z.infer<typeof ProvenanceSubjectKind>;

export const ProvenanceRecord = z.object({
  id: Id,
  workspaceId: Id,
  subjectKind: ProvenanceSubjectKind,
  subjectId: Id,
  event: ProvenanceEventKind,
  actorIdentityId: Id.nullable(),
  /** The thing this subject came from, when the event is a derivation. */
  sourceKind: ProvenanceSubjectKind.nullable(),
  sourceId: Id.nullable(),
  /** Model that performed the step (extraction, embedding, generation). */
  modelVersionId: Id.nullable(),
  details: Metadata,
  createdAt: Timestamp,
});
export type ProvenanceRecord = z.infer<typeof ProvenanceRecord>;

/**
 * Immutable security audit event. The database forbids UPDATE and DELETE on
 * this table (trigger). Records who did what, where, and the outcome.
 */
export const AuditEventType = z.enum([
  "auth.register",
  "auth.login",
  "auth.login_failed",
  "auth.logout",
  "auth.session_refreshed",
  "auth.session_revoked",
  "workspace.created",
  "workspace.settings_updated",
  "workspace.member_added",
  "workspace.member_removed",
  "authorization.denied",
  "authorization.requires_approval",
  "conversation.created",
  "conversation.deleted",
  "message.created",
  "model_run.started",
  "model_run.finished",
  "model_run.refused",
  "model_run.failed",
  "model.registered",
  "model.status_changed",
  "knowledge.created",
  "knowledge.deleted",
  "knowledge.privacy_changed",
  "knowledge.exported",
  "account.export_requested",
  "account.deletion_requested",
  "budget.exceeded",
  "rate_limit.exceeded",
]);
export type AuditEventType = z.infer<typeof AuditEventType>;

export const AuditEvent = z.object({
  id: Id,
  workspaceId: Id.nullable(),
  actorIdentityId: Id.nullable(),
  actorUserId: Id.nullable(),
  eventType: AuditEventType,
  resourceKind: z.string().nullable(),
  resourceId: Id.nullable(),
  outcome: z.enum(["SUCCESS", "FAILURE", "DENIED"]),
  ipAddress: z.string().nullable(),
  userAgent: z.string().nullable(),
  details: Metadata,
  createdAt: Timestamp,
});
export type AuditEvent = z.infer<typeof AuditEvent>;
