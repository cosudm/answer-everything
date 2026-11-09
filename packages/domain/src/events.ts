import { z } from "zod";
import { Id, Metadata, Timestamp } from "./common.js";

/**
 * Asynchronous work. The MVP queue is PostgreSQL-backed (SKIP LOCKED); the
 * interface is broker-neutral so Service Bus / SQS can replace it without
 * touching producers or handlers.
 */
export const JobType = z.enum([
  "knowledge.ingest",
  "knowledge.reindex",
  "answer.verify_claims",
  "research.run",
  "evaluation.run_suite",
  "model.health_check",
  "account.export",
  "account.delete",
  "retention.sweep",
]);
export type JobType = z.infer<typeof JobType>;

export const JobStatus = z.enum(["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "DEAD"]);
export type JobStatus = z.infer<typeof JobStatus>;

export const Job = z.object({
  id: Id,
  type: JobType,
  workspaceId: Id.nullable(),
  /** Identity the handler runs as; defaults to the platform SERVICE identity. */
  actingIdentityId: Id.nullable(),
  payload: Metadata,
  status: JobStatus,
  attempts: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
  runAt: Timestamp,
  lockedAt: Timestamp.nullable(),
  lockedBy: z.string().nullable(),
  lastError: z.string().nullable(),
  createdAt: Timestamp,
  finishedAt: Timestamp.nullable(),
});
export type Job = z.infer<typeof Job>;

export const KnowledgeIngestPayload = z.object({
  knowledgeObjectId: Id,
  workspaceId: Id,
});
export type KnowledgeIngestPayload = z.infer<typeof KnowledgeIngestPayload>;

/** Domain events emitted after state changes (in-process bus in MVP). */
export const DomainEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("knowledge.ready"),
    workspaceId: Id,
    knowledgeObjectId: Id,
    chunkCount: z.number().int(),
  }),
  z.object({
    type: z.literal("knowledge.failed"),
    workspaceId: Id,
    knowledgeObjectId: Id,
    reason: z.string(),
  }),
  z.object({
    type: z.literal("answer.recorded"),
    workspaceId: Id,
    answerRecordId: Id,
    disposition: z.string(),
  }),
  z.object({
    type: z.literal("budget.exceeded"),
    workspaceId: Id,
    spentUsd: z.number(),
    limitUsd: z.number(),
  }),
]);
export type DomainEvent = z.infer<typeof DomainEvent>;
