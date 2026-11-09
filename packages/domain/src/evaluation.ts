import { z } from "zod";
import { Id, Metadata, Timestamp } from "./common.js";

export const EvaluationCategory = z.enum([
  "CAPABILITY",
  "RELIABILITY",
  "BEHAVIORAL_LATITUDE",
  "SECURITY",
  "GOVERNANCE",
]);
export type EvaluationCategory = z.infer<typeof EvaluationCategory>;

/**
 * Graders are deterministic where possible. `model_judge` graders record
 * which model judged, and are never the sole basis for APPROVED status.
 */
export const GraderKind = z.enum([
  "exact_match",
  "contains_all",
  "contains_none",
  "regex",
  "json_valid",
  "json_schema",
  "refusal_expected",
  "answer_expected",
  "no_secret_leak",
  "model_judge",
]);
export type GraderKind = z.infer<typeof GraderKind>;

export const EvaluationCase = z.object({
  id: Id,
  suiteId: Id,
  name: z.string(),
  /** Messages sent to the model under test. */
  input: z.object({
    system: z.string().nullable(),
    messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() })),
  }),
  grader: GraderKind,
  /** Grader-specific expectation (strings, regex, schema, secret tokens...). */
  expected: Metadata,
  tags: z.array(z.string()),
  weight: z.number().positive().default(1),
});
export type EvaluationCase = z.infer<typeof EvaluationCase>;

export const EvaluationSuite = z.object({
  id: Id,
  slug: z.string(),
  name: z.string(),
  category: EvaluationCategory,
  description: z.string(),
  version: z.string(),
  cases: z.array(EvaluationCase),
});
export type EvaluationSuite = z.infer<typeof EvaluationSuite>;

export const EvaluationRunStatus = z.enum(["QUEUED", "RUNNING", "COMPLETED", "FAILED"]);
export type EvaluationRunStatus = z.infer<typeof EvaluationRunStatus>;

export const EvaluationResult = z.object({
  id: Id,
  runId: Id,
  caseId: Id,
  modelRunId: Id.nullable(),
  passed: z.boolean(),
  score: z.number().min(0).max(1),
  output: z.string().nullable(),
  details: Metadata,
});
export type EvaluationResult = z.infer<typeof EvaluationResult>;

/**
 * A run of one suite against one model version. Scores on the Model Lab
 * screen come from these rows and nowhere else.
 */
export const EvaluationRun = z.object({
  id: Id,
  suiteId: Id,
  suiteVersion: z.string(),
  modelVersionId: Id,
  /** Model the modified checkpoint is compared with, when applicable. */
  baselineModelVersionId: Id.nullable(),
  status: EvaluationRunStatus,
  startedAt: Timestamp,
  finishedAt: Timestamp.nullable(),
  summary: z
    .object({
      cases: z.number().int(),
      passed: z.number().int(),
      failed: z.number().int(),
      weightedScore: z.number().min(0).max(1),
      /** Fraction of cases where the model refused when an answer was expected. */
      excessiveRefusalRate: z.number().min(0).max(1).nullable(),
      /** Fraction of cases where the model answered when refusal was expected. */
      missedRefusalRate: z.number().min(0).max(1).nullable(),
    })
    .nullable(),
  triggeredByIdentityId: Id.nullable(),
  error: z.string().nullable(),
});
export type EvaluationRun = z.infer<typeof EvaluationRun>;
