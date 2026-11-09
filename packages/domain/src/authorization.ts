import { z } from "zod";
import { Id, PrivacyClass, Timestamp } from "./common.js";

/**
 * Every protected operation names an Action on a ResourceKind. The vocabulary
 * is closed so that policies can be enumerated, tested, and audited.
 */
export const Action = z.enum([
  // workspace & membership
  "workspace.read",
  "workspace.update",
  "workspace.delete",
  "workspace.members.manage",
  "workspace.settings.update",
  // projects
  "project.create",
  "project.read",
  "project.update",
  "project.delete",
  // conversations & messages
  "conversation.create",
  "conversation.read",
  "conversation.append",
  "conversation.branch",
  "conversation.delete",
  "conversation.share",
  // knowledge
  "knowledge.create",
  "knowledge.read",
  "knowledge.update",
  "knowledge.delete",
  "knowledge.export",
  "knowledge.retrieve_for_model",
  // models
  "model.use",
  "model.compare",
  "model.register",
  "model.approve",
  "model.disable",
  "model.evaluate",
  // actions through the Action Gateway
  "action.propose",
  "action.execute",
  // account / data governance
  "account.export",
  "account.delete",
  "audit.read",
]);
export type Action = z.infer<typeof Action>;

export const ResourceKind = z.enum([
  "WORKSPACE",
  "PROJECT",
  "CONVERSATION",
  "MESSAGE",
  "KNOWLEDGE_OBJECT",
  "KNOWLEDGE_CHUNK",
  "MODEL_VERSION",
  "ACTION",
  "ACCOUNT",
  "AUDIT_LOG",
]);
export type ResourceKind = z.infer<typeof ResourceKind>;

/**
 * The full Identity Governed Logic question:
 *   WHO (userId) AS WHOM (actingIdentityId) IN WHICH WORKSPACE
 *   USING WHICH INFORMATION (informationPrivacyClass) FOR WHICH PURPOSE
 *   THROUGH WHICH MODEL OR AGENT (modelVersionId) WITH WHICH AUTHORITY (role)
 *   TO PERFORM WHICH ACTION (action on resource)
 */
export const AuthorizationRequest = z.object({
  userId: Id.nullable(),
  actingIdentityId: Id,
  workspaceId: Id.nullable(),
  action: Action,
  resource: z.object({
    kind: ResourceKind,
    id: Id.nullable(),
    /** Who owns the resource, when relevant (e.g. conversations, knowledge). */
    ownerUserId: Id.nullable().optional(),
    privacyClass: PrivacyClass.nullable().optional(),
    workspaceId: Id.nullable().optional(),
    /** Resource-specific facts policies may need (e.g. aiUsePermission, kind). */
    attributes: z.record(z.string(), z.unknown()).optional(),
  }),
  purpose: z.string().max(200).default("unspecified"),
  /** Model or agent the information would flow through, if any. */
  modelVersionId: Id.nullable().default(null),
  informationPrivacyClass: PrivacyClass.nullable().default(null),
});
export type AuthorizationRequest = z.infer<typeof AuthorizationRequest>;

export const AuthorizationOutcome = z.enum(["ALLOW", "DENY", "REQUIRES_APPROVAL"]);
export type AuthorizationOutcome = z.infer<typeof AuthorizationOutcome>;

export const AuthorizationObligations = z.object({
  humanApproval: z.boolean().optional(),
  recordAudit: z.boolean().optional(),
  maskFields: z.array(z.string()).optional(),
  restrictModels: z.array(Id).optional(),
  /** Retrieval must be filtered to at most this privacy class. */
  maxPrivacyClass: PrivacyClass.optional(),
});
export type AuthorizationObligations = z.infer<typeof AuthorizationObligations>;

export const AuthorizationDecision = z.object({
  outcome: AuthorizationOutcome,
  policyIds: z.array(z.string()),
  reasonCodes: z.array(z.string()),
  obligations: AuthorizationObligations.optional(),
});
export type AuthorizationDecision = z.infer<typeof AuthorizationDecision>;

/** Persisted copy of a decision so the Answer Path can show why access was granted or refused. */
export const AuthorizationDecisionRecord = AuthorizationDecision.extend({
  id: Id,
  workspaceId: Id.nullable(),
  actingIdentityId: Id,
  action: Action,
  resourceKind: ResourceKind,
  resourceId: Id.nullable(),
  createdAt: Timestamp,
});
export type AuthorizationDecisionRecord = z.infer<typeof AuthorizationDecisionRecord>;

export const REASON = {
  NO_MEMBERSHIP: "NO_MEMBERSHIP",
  ROLE_INSUFFICIENT: "ROLE_INSUFFICIENT",
  OWNER_ONLY: "OWNER_ONLY",
  CROSS_WORKSPACE: "CROSS_WORKSPACE",
  PRIVACY_CLASS_EXCEEDS_MODEL: "PRIVACY_CLASS_EXCEEDS_MODEL",
  PRIVACY_CLASS_EXCEEDS_WORKSPACE: "PRIVACY_CLASS_EXCEEDS_WORKSPACE",
  MODEL_NOT_APPROVED: "MODEL_NOT_APPROVED",
  MODEL_DISABLED: "MODEL_DISABLED",
  EXPERIMENTAL_NOT_ALLOWED: "EXPERIMENTAL_NOT_ALLOWED",
  COMMERCIAL_PROVIDER_NOT_ALLOWED: "COMMERCIAL_PROVIDER_NOT_ALLOWED",
  IDENTITY_REVOKED: "IDENTITY_REVOKED",
  AGENT_EXCEEDS_DELEGATOR: "AGENT_EXCEEDS_DELEGATOR",
  CONSEQUENTIAL_ACTION: "CONSEQUENTIAL_ACTION",
  NO_MATCHING_POLICY: "NO_MATCHING_POLICY",
  AI_USE_DENIED: "AI_USE_DENIED",
  ALLOWED_BY_ROLE: "ALLOWED_BY_ROLE",
  ALLOWED_BY_OWNERSHIP: "ALLOWED_BY_OWNERSHIP",
  ALLOWED_SELF: "ALLOWED_SELF",
} as const;
export type ReasonCode = (typeof REASON)[keyof typeof REASON];
