import { z } from "zod";
import { AnswerRecord } from "./answer.js";
import { Id } from "./common.js";
import { ContextManifest } from "./context-manifest.js";
import { Message } from "./conversation.js";
import { ModelRun } from "./model-run.js";

/**
 * Server-Sent Events emitted by POST /v1/conversations/:id/messages.
 * The browser renders these; nothing provider-specific reaches it.
 */
export const AskStreamEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("accepted"),
    userMessage: Message,
    assistantMessageId: Id,
  }),
  z.object({
    type: z.literal("path"),
    step: z.string(),
    detail: z.string().nullable(),
  }),
  z.object({
    type: z.literal("context"),
    manifest: ContextManifest,
  }),
  z.object({
    type: z.literal("model_selected"),
    modelVersionId: Id,
    displayName: z.string(),
    providerSlug: z.string(),
    deploymentType: z.string(),
    reason: z.string(),
    /** For Compare: which lane this model occupies. */
    lane: z.number().int().nonnegative().optional(),
  }),
  z.object({ type: z.literal("delta"), text: z.string(), lane: z.number().int().optional() }),
  z.object({
    type: z.literal("notice"),
    level: z.enum(["info", "warning"]),
    message: z.string(),
    lane: z.number().int().optional(),
  }),
  z.object({
    type: z.literal("complete"),
    assistantMessage: Message,
    answerRecord: AnswerRecord,
    modelRuns: z.array(ModelRun),
    lane: z.number().int().optional(),
  }),
  z.object({
    type: z.literal("error"),
    code: z.string(),
    message: z.string(),
    lane: z.number().int().optional(),
  }),
]);
export type AskStreamEvent = z.infer<typeof AskStreamEvent>;

export const ApiError = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
    requestId: z.string().optional(),
  }),
});
export type ApiError = z.infer<typeof ApiError>;
