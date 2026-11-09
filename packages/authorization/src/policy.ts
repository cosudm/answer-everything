import type {
  Action,
  AuthorizationDecision,
  AuthorizationRequest,
  DeploymentType,
  EvaluationStatus,
  PrivacyClass,
  WorkspaceRole,
  WorkspaceSettings,
} from "@ae/domain";
import { PRIVACY_RANK, REASON, ROLE_RANK } from "@ae/domain";

/**
 * Facts the policy engine needs. Loaded by the caller (DB-backed in the API,
 * in-memory in tests) so the engine itself is pure and exhaustively testable.
 */
export interface PolicyFacts {
  identity: { kind: "USER" | "SERVICE" | "AGENT"; revoked: boolean; userId: string | null } | null;
  user: { platformRole: "USER" | "PLATFORM_ADMIN"; status: string } | null;
  membership: { role: WorkspaceRole } | null;
  workspace: { settings: WorkspaceSettings } | null;
  model: {
    enabled: boolean;
    evaluationStatus: EvaluationStatus;
    deploymentType: DeploymentType;
    behavioralProfile: string;
    privacyClassesAllowed: PrivacyClass[];
    providerEnabled: boolean;
  } | null;
}

/** Minimum role per action. Actions absent here are handled by dedicated policies. */
const MIN_ROLE: Partial<Record<Action, WorkspaceRole>> = {
  "workspace.read": "VIEWER",
  "workspace.update": "ADMIN",
  "workspace.delete": "OWNER",
  "workspace.members.manage": "ADMIN",
  "workspace.settings.update": "ADMIN",
  "project.create": "MEMBER",
  "project.read": "VIEWER",
  "project.update": "MEMBER",
  "project.delete": "ADMIN",
  "conversation.create": "MEMBER",
  "conversation.read": "VIEWER",
  "conversation.append": "MEMBER",
  "conversation.branch": "MEMBER",
  "conversation.delete": "MEMBER", // owner of the conversation; ADMIN otherwise (ownership policy)
  "conversation.share": "MEMBER",
  "knowledge.create": "MEMBER",
  "knowledge.read": "VIEWER",
  "knowledge.update": "MEMBER",
  "knowledge.delete": "MEMBER",
  "knowledge.export": "MEMBER",
  "knowledge.retrieve_for_model": "VIEWER",
  "model.use": "MEMBER",
  "model.compare": "MEMBER",
  "action.propose": "MEMBER",
  "action.execute": "MEMBER",
  "audit.read": "ADMIN",
};

/** Actions where a MEMBER may act only on resources they own; others need ADMIN. */
const OWNER_OR_ADMIN: Set<Action> = new Set(["conversation.delete", "knowledge.update", "knowledge.delete", "project.update"]);

const PLATFORM_ADMIN_ONLY: Set<Action> = new Set(["model.register", "model.approve", "model.disable", "model.evaluate"]);

const SELF_ONLY: Set<Action> = new Set(["account.export", "account.delete"]);

/** Agents (model-driven identities) may never perform these regardless of delegator. */
const AGENT_FORBIDDEN: Set<Action> = new Set([
  "workspace.update",
  "workspace.delete",
  "workspace.members.manage",
  "workspace.settings.update",
  "model.register",
  "model.approve",
  "model.disable",
  "knowledge.delete",
  "knowledge.export",
  "account.export",
  "account.delete",
  "action.execute",
]);

export function deny(reason: string, policyIds: string[], extra: string[] = []): AuthorizationDecision {
  return { outcome: "DENY", policyIds, reasonCodes: [reason, ...extra] };
}

/**
 * Pure, deny-by-default policy evaluation. Order matters: identity and
 * boundary checks come first so a revoked identity or cross-workspace
 * reference is refused before any role logic runs.
 */
export function evaluate(req: AuthorizationRequest, facts: PolicyFacts): AuthorizationDecision {
  const policies: string[] = [];

  // P-IDENTITY
  policies.push("P-IDENTITY");
  if (!facts.identity || facts.identity.revoked) return deny(REASON.IDENTITY_REVOKED, policies);
  if (facts.user && facts.user.status !== "ACTIVE") return deny(REASON.IDENTITY_REVOKED, policies);

  // P-AGENT: model-driven identities have a hard ceiling.
  if (facts.identity.kind === "AGENT") {
    policies.push("P-AGENT");
    if (AGENT_FORBIDDEN.has(req.action)) return deny(REASON.AGENT_EXCEEDS_DELEGATOR, policies);
  }

  // P-PLATFORM-ADMIN
  if (PLATFORM_ADMIN_ONLY.has(req.action)) {
    policies.push("P-PLATFORM-ADMIN");
    if (facts.user?.platformRole === "PLATFORM_ADMIN") {
      return { outcome: "ALLOW", policyIds: policies, reasonCodes: [REASON.ALLOWED_BY_ROLE], obligations: { recordAudit: true } };
    }
    return deny(REASON.ROLE_INSUFFICIENT, policies);
  }

  // P-SELF: account-level actions
  if (SELF_ONLY.has(req.action)) {
    policies.push("P-SELF");
    if (req.userId && req.resource.ownerUserId === req.userId && facts.identity.kind === "USER") {
      return { outcome: "ALLOW", policyIds: policies, reasonCodes: [REASON.ALLOWED_SELF], obligations: { recordAudit: true } };
    }
    return deny(REASON.OWNER_ONLY, policies);
  }

  // Everything below is workspace-scoped.
  policies.push("P-MEMBERSHIP");
  if (!req.workspaceId || !facts.membership) return deny(REASON.NO_MEMBERSHIP, policies);

  // P-CROSS-WORKSPACE: a resource from another workspace is never reachable here.
  policies.push("P-CROSS-WORKSPACE");
  if (req.resource.workspaceId && req.resource.workspaceId !== req.workspaceId) {
    return deny(REASON.CROSS_WORKSPACE, policies);
  }

  // P-ROLE
  policies.push("P-ROLE");
  const minRole = MIN_ROLE[req.action];
  if (!minRole) return deny(REASON.NO_MATCHING_POLICY, policies);
  const role = facts.membership.role;
  if (ROLE_RANK[role] < ROLE_RANK[minRole]) return deny(REASON.ROLE_INSUFFICIENT, policies);

  const reasons: string[] = [REASON.ALLOWED_BY_ROLE];

  // P-OWNERSHIP
  if (OWNER_OR_ADMIN.has(req.action)) {
    policies.push("P-OWNERSHIP");
    const isOwner = req.resource.ownerUserId != null && req.resource.ownerUserId === req.userId;
    const isAdmin = ROLE_RANK[role] >= ROLE_RANK.ADMIN;
    if (!isOwner && !isAdmin) return deny(REASON.OWNER_ONLY, policies);
    reasons.push(isOwner ? REASON.ALLOWED_BY_OWNERSHIP : REASON.ALLOWED_BY_ROLE);
  }

  // P-PRIVACY-WORKSPACE: nothing may be classified above the workspace ceiling.
  if ((req.action === "knowledge.create" || req.action === "knowledge.update" || req.action === "project.create") && req.resource.privacyClass) {
    policies.push("P-PRIVACY-WORKSPACE");
    const max = facts.workspace?.settings.maxPrivacyClass ?? "INTERNAL";
    if (PRIVACY_RANK[req.resource.privacyClass] > PRIVACY_RANK[max]) {
      return deny(REASON.PRIVACY_CLASS_EXCEEDS_WORKSPACE, policies);
    }
  }

  // P-AI-USE: knowledge the owner marked as not for AI never reaches a model.
  if (req.action === "knowledge.retrieve_for_model") {
    policies.push("P-AI-USE");
    if (req.resource.attributes?.aiUsePermission === "DENY") return deny(REASON.AI_USE_DENIED, policies);
  }

  // P-MODEL: using a model requires it to be enabled, approved (or explicitly
  // allowed while testing), permitted for the provider class, and cleared for
  // the information privacy class.
  if (req.action === "model.use" || req.action === "model.compare" || req.action === "knowledge.retrieve_for_model") {
    if (req.modelVersionId) {
      policies.push("P-MODEL");
      const m = facts.model;
      if (!m || !m.enabled || !m.providerEnabled) return deny(REASON.MODEL_DISABLED, policies);
      if (m.evaluationStatus === "REJECTED") return deny(REASON.MODEL_NOT_APPROVED, policies);
      const allowExperimental = facts.workspace?.settings.allowExperimentalModels ?? false;
      if (m.evaluationStatus !== "APPROVED" || m.behavioralProfile === "EXPERIMENTAL") {
        if (!allowExperimental) return deny(REASON.EXPERIMENTAL_NOT_ALLOWED, policies);
      }
      if (m.deploymentType === "COMMERCIAL_API" && facts.workspace?.settings.allowCommercialProviders === false) {
        return deny(REASON.COMMERCIAL_PROVIDER_NOT_ALLOWED, policies);
      }
      const cls = req.informationPrivacyClass ?? req.resource.privacyClass ?? null;
      if (cls && !m.privacyClassesAllowed.includes(cls)) {
        return deny(REASON.PRIVACY_CLASS_EXCEEDS_MODEL, policies);
      }
    }
  }

  // P-ACTION-GATEWAY: executing consequential actions needs human approval.
  if (req.action === "action.execute") {
    policies.push("P-ACTION-GATEWAY");
    return {
      outcome: "REQUIRES_APPROVAL",
      policyIds: policies,
      reasonCodes: [REASON.CONSEQUENTIAL_ACTION],
      obligations: { humanApproval: true, recordAudit: true },
    };
  }

  const obligations: NonNullable<AuthorizationDecision["obligations"]> = {};
  if (facts.model) {
    // Retrieval must never exceed what the model may see.
    const allowed = facts.model.privacyClassesAllowed;
    let max: PrivacyClass = "PUBLIC";
    for (const c of allowed) if (PRIVACY_RANK[c] > PRIVACY_RANK[max]) max = c;
    obligations.maxPrivacyClass = max;
  }
  if (req.action.endsWith(".delete") || req.action === "workspace.settings.update" || req.action === "workspace.members.manage") {
    obligations.recordAudit = true;
  }

  return { outcome: "ALLOW", policyIds: policies, reasonCodes: reasons, obligations };
}
