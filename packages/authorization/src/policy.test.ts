import { describe, expect, it } from "vitest";
import type { AuthorizationRequest } from "@ae/domain";
import { REASON, WorkspaceSettings } from "@ae/domain";
import { evaluate, type PolicyFacts } from "./policy.js";

const USER = "11111111-1111-4111-8111-111111111111";
const IDENTITY = "22222222-2222-4222-8222-222222222222";
const WS = "33333333-3333-4333-8333-333333333333";
const OTHER_WS = "44444444-4444-4444-8444-444444444444";
const MODEL = "55555555-5555-4555-8555-555555555555";

function req(partial: Partial<AuthorizationRequest> & { action: AuthorizationRequest["action"] }): AuthorizationRequest {
  return {
    userId: USER,
    actingIdentityId: IDENTITY,
    workspaceId: WS,
    resource: { kind: "CONVERSATION", id: null, workspaceId: WS, ownerUserId: USER, privacyClass: null },
    purpose: "test",
    modelVersionId: null,
    informationPrivacyClass: null,
    ...partial,
  };
}

function facts(partial: Partial<PolicyFacts> = {}): PolicyFacts {
  return {
    identity: { kind: "USER", revoked: false, userId: USER },
    user: { platformRole: "USER", status: "ACTIVE" },
    membership: { role: "MEMBER" },
    workspace: { settings: WorkspaceSettings.parse({}) },
    model: null,
    ...partial,
  };
}

const approvedModel: NonNullable<PolicyFacts["model"]> = {
  enabled: true,
  evaluationStatus: "APPROVED",
  deploymentType: "COMMERCIAL_API",
  behavioralProfile: "STANDARD",
  privacyClassesAllowed: ["PUBLIC", "INTERNAL"],
  providerEnabled: true,
};

describe("deny by default", () => {
  it("denies when the identity is unknown or revoked", () => {
    expect(evaluate(req({ action: "conversation.read" }), facts({ identity: null })).outcome).toBe("DENY");
    const d = evaluate(req({ action: "conversation.read" }), facts({ identity: { kind: "USER", revoked: true, userId: USER } }));
    expect(d.reasonCodes).toContain(REASON.IDENTITY_REVOKED);
  });
  it("denies without membership", () => {
    const d = evaluate(req({ action: "conversation.read" }), facts({ membership: null }));
    expect(d.outcome).toBe("DENY");
    expect(d.reasonCodes).toContain(REASON.NO_MEMBERSHIP);
  });
  it("denies when no workspace is in the request for a workspace action", () => {
    expect(evaluate(req({ action: "knowledge.read", workspaceId: null }), facts()).outcome).toBe("DENY");
  });
});

describe("workspace boundary", () => {
  it("denies a resource from another workspace even for owners", () => {
    const d = evaluate(
      req({ action: "conversation.read", resource: { kind: "CONVERSATION", id: null, workspaceId: OTHER_WS } }),
      facts({ membership: { role: "OWNER" } }),
    );
    expect(d.outcome).toBe("DENY");
    expect(d.reasonCodes).toContain(REASON.CROSS_WORKSPACE);
  });
});

describe("roles and ownership", () => {
  it("viewers can read but not append", () => {
    const f = facts({ membership: { role: "VIEWER" } });
    expect(evaluate(req({ action: "conversation.read" }), f).outcome).toBe("ALLOW");
    expect(evaluate(req({ action: "conversation.append" }), f).reasonCodes).toContain(REASON.ROLE_INSUFFICIENT);
  });
  it("members may delete only their own conversations; admins may delete any", () => {
    const other = { kind: "CONVERSATION" as const, id: null, workspaceId: WS, ownerUserId: "99999999-9999-4999-8999-999999999999" };
    expect(evaluate(req({ action: "conversation.delete", resource: other }), facts()).reasonCodes).toContain(REASON.OWNER_ONLY);
    expect(evaluate(req({ action: "conversation.delete" }), facts()).reasonCodes).toContain(REASON.ALLOWED_BY_OWNERSHIP);
    expect(evaluate(req({ action: "conversation.delete", resource: other }), facts({ membership: { role: "ADMIN" } })).outcome).toBe("ALLOW");
  });
  it("only owners delete workspaces", () => {
    expect(evaluate(req({ action: "workspace.delete" }), facts({ membership: { role: "ADMIN" } })).outcome).toBe("DENY");
    expect(evaluate(req({ action: "workspace.delete" }), facts({ membership: { role: "OWNER" } })).outcome).toBe("ALLOW");
  });
  it("platform admin actions ignore workspace role", () => {
    expect(evaluate(req({ action: "model.approve" }), facts({ membership: { role: "OWNER" } })).outcome).toBe("DENY");
    expect(
      evaluate(req({ action: "model.approve" }), facts({ user: { platformRole: "PLATFORM_ADMIN", status: "ACTIVE" } })).outcome,
    ).toBe("ALLOW");
  });
  it("account export/delete is self only", () => {
    expect(evaluate(req({ action: "account.export", resource: { kind: "ACCOUNT", id: null, ownerUserId: USER } }), facts()).outcome).toBe("ALLOW");
    expect(
      evaluate(req({ action: "account.export", resource: { kind: "ACCOUNT", id: null, ownerUserId: OTHER_WS } }), facts()).outcome,
    ).toBe("DENY");
  });
});

describe("privacy and model gating", () => {
  it("denies model use when information exceeds the model's privacy clearance", () => {
    const d = evaluate(
      req({ action: "model.use", modelVersionId: MODEL, informationPrivacyClass: "CONFIDENTIAL", resource: { kind: "MODEL_VERSION", id: MODEL } }),
      facts({ model: approvedModel }),
    );
    expect(d.reasonCodes).toContain(REASON.PRIVACY_CLASS_EXCEEDS_MODEL);
  });
  it("allows model use within clearance and emits a retrieval ceiling obligation", () => {
    const d = evaluate(
      req({ action: "model.use", modelVersionId: MODEL, informationPrivacyClass: "INTERNAL", resource: { kind: "MODEL_VERSION", id: MODEL } }),
      facts({ model: approvedModel }),
    );
    expect(d.outcome).toBe("ALLOW");
    expect(d.obligations?.maxPrivacyClass).toBe("INTERNAL");
  });
  it("blocks TESTING / EXPERIMENTAL models unless the workspace opted in", () => {
    const testing = { ...approvedModel, evaluationStatus: "TESTING" as const };
    const base = req({ action: "model.use", modelVersionId: MODEL, resource: { kind: "MODEL_VERSION", id: MODEL } });
    expect(evaluate(base, facts({ model: testing })).reasonCodes).toContain(REASON.EXPERIMENTAL_NOT_ALLOWED);
    expect(
      evaluate(base, facts({ model: testing, workspace: { settings: WorkspaceSettings.parse({ allowExperimentalModels: true }) } })).outcome,
    ).toBe("ALLOW");
    const experimentalProfile = { ...approvedModel, behavioralProfile: "EXPERIMENTAL" };
    expect(evaluate(base, facts({ model: experimentalProfile })).reasonCodes).toContain(REASON.EXPERIMENTAL_NOT_ALLOWED);
  });
  it("never allows REJECTED or disabled models", () => {
    const base = req({ action: "model.use", modelVersionId: MODEL, resource: { kind: "MODEL_VERSION", id: MODEL } });
    const opted = { settings: WorkspaceSettings.parse({ allowExperimentalModels: true }) };
    expect(evaluate(base, facts({ model: { ...approvedModel, evaluationStatus: "REJECTED" }, workspace: opted })).reasonCodes).toContain(REASON.MODEL_NOT_APPROVED);
    expect(evaluate(base, facts({ model: { ...approvedModel, enabled: false } })).reasonCodes).toContain(REASON.MODEL_DISABLED);
    expect(evaluate(base, facts({ model: { ...approvedModel, providerEnabled: false } })).reasonCodes).toContain(REASON.MODEL_DISABLED);
  });
  it("respects the commercial-provider switch", () => {
    const base = req({ action: "model.use", modelVersionId: MODEL, resource: { kind: "MODEL_VERSION", id: MODEL } });
    const noCommercial = { settings: WorkspaceSettings.parse({ allowCommercialProviders: false }) };
    expect(evaluate(base, facts({ model: approvedModel, workspace: noCommercial })).reasonCodes).toContain(REASON.COMMERCIAL_PROVIDER_NOT_ALLOWED);
    expect(evaluate(base, facts({ model: { ...approvedModel, deploymentType: "DEDICATED_ENDPOINT" }, workspace: noCommercial })).outcome).toBe("ALLOW");
  });
  it("blocks knowledge above the workspace ceiling", () => {
    const d = evaluate(
      req({ action: "knowledge.create", resource: { kind: "KNOWLEDGE_OBJECT", id: null, workspaceId: WS, privacyClass: "RESTRICTED" } }),
      facts(),
    );
    expect(d.reasonCodes).toContain(REASON.PRIVACY_CLASS_EXCEEDS_WORKSPACE);
  });
  it("honours the owner's AI-use denial on retrieval", () => {
    const d = evaluate(
      req({
        action: "knowledge.retrieve_for_model",
        resource: { kind: "KNOWLEDGE_OBJECT", id: null, workspaceId: WS, attributes: { aiUsePermission: "DENY" } },
      }),
      facts(),
    );
    expect(d.reasonCodes).toContain(REASON.AI_USE_DENIED);
  });
});

describe("agents and actions", () => {
  it("agent identities cannot perform administrative or destructive actions", () => {
    const agent = facts({ identity: { kind: "AGENT", revoked: false, userId: USER }, membership: { role: "OWNER" } });
    expect(evaluate(req({ action: "knowledge.delete" }), agent).reasonCodes).toContain(REASON.AGENT_EXCEEDS_DELEGATOR);
    expect(evaluate(req({ action: "conversation.append" }), agent).outcome).toBe("ALLOW");
  });
  it("executing a consequential action requires human approval", () => {
    const d = evaluate(req({ action: "action.execute", resource: { kind: "ACTION", id: null, workspaceId: WS } }), facts());
    expect(d.outcome).toBe("REQUIRES_APPROVAL");
    expect(d.obligations?.humanApproval).toBe(true);
  });
});
