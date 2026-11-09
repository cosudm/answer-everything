import { z } from "zod";
import { Id, Metadata, Timestamp } from "./common.js";

/**
 * Research is a visible, multi-step process. These contracts define the
 * persisted shape; the worker executes steps asynchronously. The MVP ships
 * the contracts and the task table; step execution is on the roadmap.
 */
export const ResearchStepKind = z.enum([
  "PLAN",
  "SEARCH_SOURCES",
  "READ_SOURCE",
  "EXTRACT_EVIDENCE",
  "FIND_CONTRADICTIONS",
  "EXTRACT_CLAIMS",
  "VERIFY",
  "SYNTHESIZE",
]);
export type ResearchStepKind = z.infer<typeof ResearchStepKind>;

export const ResearchStepStatus = z.enum(["PENDING", "RUNNING", "DONE", "FAILED", "SKIPPED"]);
export type ResearchStepStatus = z.infer<typeof ResearchStepStatus>;

export const ResearchStep = z.object({
  id: Id,
  taskId: Id,
  ordinal: z.number().int().nonnegative(),
  kind: ResearchStepKind,
  status: ResearchStepStatus,
  input: Metadata,
  output: Metadata.nullable(),
  modelRunIds: z.array(Id),
  startedAt: Timestamp.nullable(),
  finishedAt: Timestamp.nullable(),
});
export type ResearchStep = z.infer<typeof ResearchStep>;

export const ResearchTaskStatus = z.enum([
  "QUEUED",
  "PLANNING",
  "GATHERING",
  "VERIFYING",
  "SYNTHESIZING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
]);
export type ResearchTaskStatus = z.infer<typeof ResearchTaskStatus>;

export const ResearchTask = z.object({
  id: Id,
  workspaceId: Id,
  conversationId: Id.nullable(),
  projectId: Id.nullable(),
  actingIdentityId: Id,
  question: z.string(),
  status: ResearchTaskStatus,
  steps: z.array(ResearchStep),
  /** Final answer record when completed. */
  answerRecordId: Id.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  finishedAt: Timestamp.nullable(),
});
export type ResearchTask = z.infer<typeof ResearchTask>;

export const EvidenceVerdict = z.enum([
  "VERIFIED_FACT",
  "SOURCED_CLAIM",
  "COMPETING_EVIDENCE",
  "INFERENCE",
  "UNCERTAIN",
  "RECOMMENDATION",
  "UNANSWERED",
]);
export type EvidenceVerdict = z.infer<typeof EvidenceVerdict>;
