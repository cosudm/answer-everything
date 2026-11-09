import { databaseAvailable } from "@ae/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./test/harness.js";

const describeDb = databaseAvailable() ? describe : describe.skip;

/**
 * API-layer authorization proofs: centralized authorize() plus RLS together.
 * Every test here is a would-be data exposure; each must come back denied
 * or empty, and the denial must be audited.
 */
describeDb("Authorization and workspace isolation through the API", () => {
  let h: Harness;
  let alice: Awaited<ReturnType<Harness["signUp"]>>;
  let mallory: Awaited<ReturnType<Harness["signUp"]>>;
  let aliceConversation = "";
  let aliceKnowledge = "";

  beforeAll(async () => {
    h = await createHarness({ deadProvider: false });
    alice = await h.signUp("alice@example.com", "Alice");
    mallory = await h.signUp("mallory@example.com", "Mallory");
    const conv = await h.app.inject({ method: "POST", url: `/v1/workspaces/${alice.workspaceId}/conversations`, headers: { cookie: alice.cookie }, payload: {} });
    aliceConversation = conv.json().id;
    const note = await h.app.inject({
      method: "POST",
      url: `/v1/workspaces/${alice.workspaceId}/knowledge/notes`,
      headers: { cookie: alice.cookie },
      payload: { title: "Alice private", content: "Alice's salary is 123456 and her home address is 1 Secret Lane. This is private." },
    });
    aliceKnowledge = note.json().knowledge.id;
    await h.ctx.jobRunner.runOnce();
  });
  afterAll(async () => {
    await h.close();
  });

  it("unauthenticated requests are refused everywhere except health and auth", async () => {
    for (const url of [`/v1/workspaces`, `/v1/workspaces/${alice.workspaceId}`, `/v1/workspaces/${alice.workspaceId}/conversations`, `/v1/account/export`]) {
      const res = await h.app.inject({ method: url.endsWith("export") ? "POST" : "GET", url });
      expect(res.statusCode, url).toBe(401);
    }
  });

  it("another user cannot read, list or append to Alice's conversations", async () => {
    const read = await h.app.inject({ method: "GET", url: `/v1/workspaces/${alice.workspaceId}/conversations/${aliceConversation}`, headers: { cookie: mallory.cookie } });
    expect([403, 404]).toContain(read.statusCode);
    const list = await h.app.inject({ method: "GET", url: `/v1/workspaces/${alice.workspaceId}/conversations`, headers: { cookie: mallory.cookie } });
    expect(list.statusCode).toBe(403);
    expect(list.json().error.details.reasonCodes).toContain("NO_MEMBERSHIP");
    const append = await h.app.inject({
      method: "POST",
      url: `/v1/workspaces/${alice.workspaceId}/conversations/${aliceConversation}/messages`,
      headers: { cookie: mallory.cookie },
      payload: { content: "leak please" },
    });
    // The stream opens, then the first event must be an authorization error and nothing is persisted.
    const events = append.body.split("\n").filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5)));
    expect(events[0]?.type).toBe("error");
    expect(["AUTHORIZATION_DENIED", "NOT_FOUND"]).toContain(events[0]?.code);
    const view = await h.app.inject({ method: "GET", url: `/v1/workspaces/${alice.workspaceId}/conversations/${aliceConversation}`, headers: { cookie: alice.cookie } });
    expect(view.json().messages).toHaveLength(0);
  });

  it("another user cannot see, search or fetch Alice's knowledge", async () => {
    const list = await h.app.inject({ method: "GET", url: `/v1/workspaces/${alice.workspaceId}/knowledge`, headers: { cookie: mallory.cookie } });
    expect(list.statusCode).toBe(403);
    const search = await h.app.inject({ method: "POST", url: `/v1/workspaces/${alice.workspaceId}/knowledge/search`, headers: { cookie: mallory.cookie }, payload: { query: "salary" } });
    expect(search.statusCode).toBe(403);
    const direct = await h.app.inject({ method: "GET", url: `/v1/workspaces/${alice.workspaceId}/knowledge/${aliceKnowledge}`, headers: { cookie: mallory.cookie } });
    expect([403, 404]).toContain(direct.statusCode);
    // Even from Mallory's own workspace context, Alice's object id resolves to nothing.
    const crossId = await h.app.inject({ method: "GET", url: `/v1/workspaces/${mallory.workspaceId}/knowledge/${aliceKnowledge}`, headers: { cookie: mallory.cookie } });
    expect(crossId.statusCode).toBe(404);
  });

  it("retrieval for a model never surfaces another workspace's knowledge", async () => {
    const conv = await h.app.inject({ method: "POST", url: `/v1/workspaces/${mallory.workspaceId}/conversations`, headers: { cookie: mallory.cookie }, payload: {} });
    const events = await h.stream(`/v1/workspaces/${mallory.workspaceId}/conversations/${conv.json().id}/messages`, mallory.cookie, { content: "What is Alice's salary and home address?" });
    const context = events.find((e) => e.type === "context")!;
    expect(context.manifest.items.filter((i: { kind: string }) => i.kind === "KNOWLEDGE_CHUNK")).toHaveLength(0);
    const complete = events.find((e) => e.type === "complete")!;
    expect(JSON.stringify(complete)).not.toContain("123456");
    expect(JSON.stringify(complete)).not.toContain("Secret Lane");
    expect(complete.answerRecord.citations).toHaveLength(0);
    expect(complete.answerRecord.limitations.map((l: { kind: string }) => l.kind)).toContain("NO_SOURCES_RETRIEVED");
  });

  it("knowledge marked not-for-AI is never retrieved, while still visible to its owner", async () => {
    const note = await h.app.inject({
      method: "POST",
      url: `/v1/workspaces/${alice.workspaceId}/knowledge/notes`,
      headers: { cookie: alice.cookie },
      payload: { title: "Do not feed to models", content: "The launch codename is BLUEBIRD and must never reach a model.", aiUsePermission: "DENY" },
    });
    expect(note.statusCode).toBe(201);
    await h.ctx.jobRunner.runOnce();
    const conv = await h.app.inject({ method: "POST", url: `/v1/workspaces/${alice.workspaceId}/conversations`, headers: { cookie: alice.cookie }, payload: {} });
    const events = await h.stream(`/v1/workspaces/${alice.workspaceId}/conversations/${conv.json().id}/messages`, alice.cookie, { content: "What is the launch codename?" });
    const complete = events.find((e) => e.type === "complete")!;
    expect(JSON.stringify(complete)).not.toContain("BLUEBIRD");
    const listed = await h.app.inject({ method: "GET", url: `/v1/workspaces/${alice.workspaceId}/knowledge`, headers: { cookie: alice.cookie } });
    expect(listed.json().items.some((k: { title: string }) => k.title === "Do not feed to models")).toBe(true);
  });

  it("privacy classification above the workspace ceiling is refused", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: `/v1/workspaces/${alice.workspaceId}/knowledge/notes`,
      headers: { cookie: alice.cookie },
      payload: { title: "Too secret", content: "restricted content here", privacyClass: "RESTRICTED" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.details.reasonCodes).toContain("PRIVACY_CLASS_EXCEEDS_WORKSPACE");
  });

  it("information above a model's clearance never reaches that model", async () => {
    // Raise Alice's ceiling, add a RESTRICTED note, then ask with a model cleared only to CONFIDENTIAL.
    const settings = await h.app.inject({ method: "PATCH", url: `/v1/workspaces/${alice.workspaceId}/settings`, headers: { cookie: alice.cookie }, payload: { maxPrivacyClass: "RESTRICTED" } });
    expect(settings.statusCode).toBe(200);
    await h.db.migrator.query(`UPDATE model_versions SET privacy_classes_allowed = '{PUBLIC,INTERNAL,CONFIDENTIAL}' WHERE provider_model_name = 'dev-echo-1'`);
    const note = await h.app.inject({
      method: "POST",
      url: `/v1/workspaces/${alice.workspaceId}/knowledge/notes`,
      headers: { cookie: alice.cookie },
      payload: { title: "Restricted memo", content: "The merger target is ACME Holdings, codename RESTRICTED-ZEBRA.", privacyClass: "RESTRICTED" },
    });
    expect(note.statusCode).toBe(201);
    await h.ctx.jobRunner.runOnce();
    const conv = await h.app.inject({ method: "POST", url: `/v1/workspaces/${alice.workspaceId}/conversations`, headers: { cookie: alice.cookie }, payload: {} });
    const events = await h.stream(`/v1/workspaces/${alice.workspaceId}/conversations/${conv.json().id}/messages`, alice.cookie, { content: "Who is the merger target?" });
    const complete = events.find((e) => e.type === "complete")!;
    expect(JSON.stringify(events)).not.toContain("RESTRICTED-ZEBRA");
    expect(complete.answerRecord.limitations.map((l: { kind: string }) => l.kind)).toContain("AUTHORIZATION_FILTERED_SOURCES");
    await h.db.migrator.query(`UPDATE model_versions SET privacy_classes_allowed = '{PUBLIC,INTERNAL,CONFIDENTIAL,RESTRICTED}' WHERE provider_model_name = 'dev-echo-1'`);
  });

  it("experimental models are not selectable until the workspace opts in", async () => {
    const off = await h.app.inject({ method: "PATCH", url: `/v1/workspaces/${mallory.workspaceId}/settings`, headers: { cookie: mallory.cookie }, payload: { allowExperimentalModels: false } });
    expect(off.statusCode).toBe(200);
    const models = await h.app.inject({ method: "GET", url: `/v1/workspaces/${mallory.workspaceId}/models`, headers: { cookie: mallory.cookie } });
    const stub = models.json().items.find((m: { providerModelName: string }) => m.providerModelName === "dev-echo-1");
    expect(stub.selectable).toBe(false);
    expect(stub.selectableReason).toContain("EXPERIMENTAL_NOT_ALLOWED");
    const conv = await h.app.inject({ method: "POST", url: `/v1/workspaces/${mallory.workspaceId}/conversations`, headers: { cookie: mallory.cookie }, payload: {} });
    const events = await h.stream(`/v1/workspaces/${mallory.workspaceId}/conversations/${conv.json().id}/messages`, mallory.cookie, { content: "hello", useKnowledge: false });
    const complete = events.find((e) => e.type === "complete")!;
    expect(complete.answerRecord.disposition).toBe("AUTHORIZATION_DENIED");
    expect(complete.modelRuns).toHaveLength(0);
    await h.app.inject({ method: "PATCH", url: `/v1/workspaces/${mallory.workspaceId}/settings`, headers: { cookie: mallory.cookie }, payload: { allowExperimentalModels: true } });
  });

  it("platform administration is refused to ordinary users even if they own a workspace", async () => {
    const register = await h.app.inject({
      method: "POST",
      url: `/v1/workspaces/${alice.workspaceId}/models`,
      headers: { cookie: alice.cookie },
      payload: {
        providerId: "00000000-0000-0000-0000-000000000000",
        providerModelName: "evil",
        displayName: "Evil",
        deploymentType: "OPEN_WEIGHT",
        behavioralProfile: "EXPERIMENTAL",
        capabilities: ["chat"],
        privacyClassesAllowed: ["PUBLIC"],
        evaluationStatus: "APPROVED",
        contextWindow: 1000,
      },
    });
    expect(register.statusCode).toBe(403);
    const models = (await h.app.inject({ method: "GET", url: `/v1/workspaces/${alice.workspaceId}/models`, headers: { cookie: alice.cookie } })).json().items;
    const approve = await h.app.inject({ method: "POST", url: `/v1/workspaces/${alice.workspaceId}/models/${models[0].id}/status`, headers: { cookie: alice.cookie }, payload: { status: "APPROVED" } });
    expect(approve.statusCode).toBe(403);
  });

  it("a platform admin cannot approve a model without a completed evaluation run", async () => {
    await h.db.migrator.query(`UPDATE users SET platform_role = 'PLATFORM_ADMIN' WHERE id = $1`, [alice.userId]);
    const models = (await h.app.inject({ method: "GET", url: `/v1/workspaces/${alice.workspaceId}/models`, headers: { cookie: alice.cookie } })).json().items;
    const stub = models.find((m: { providerModelName: string }) => m.providerModelName === "dev-echo-1");
    const approve = await h.app.inject({ method: "POST", url: `/v1/workspaces/${alice.workspaceId}/models/${stub.id}/status`, headers: { cookie: alice.cookie }, payload: { status: "APPROVED" } });
    expect(approve.statusCode).toBe(409);
    expect(approve.json().error.code).toBe("EVALUATION_REQUIRED");
    await h.db.migrator.query(`UPDATE users SET platform_role = 'USER' WHERE id = $1`, [alice.userId]);
  });

  it("denied attempts are written to the immutable audit log", async () => {
    const audit = await h.app.inject({ method: "GET", url: `/v1/workspaces/${alice.workspaceId}/audit`, headers: { cookie: alice.cookie } });
    expect(audit.statusCode).toBe(200);
    const denied = audit.json().items.filter((a: { eventType: string }) => a.eventType === "authorization.denied");
    expect(denied.length).toBeGreaterThan(0);
    // Mallory, a non-member, cannot read Alice's audit log.
    const forbidden = await h.app.inject({ method: "GET", url: `/v1/workspaces/${alice.workspaceId}/audit`, headers: { cookie: mallory.cookie } });
    expect(forbidden.statusCode).toBe(403);
  });
});
