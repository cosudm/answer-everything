import { databaseAvailable } from "@ae/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./test/harness.js";

const describeDb = databaseAvailable() ? describe : describe.skip;

describeDb("API vertical slice: authentication through a streaming answer", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  it("health reports the database and embedding model", async () => {
    const res = await h.app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok", db: "ok", embeddingModel: "configured" });
  });

  it("rejects weak passwords and duplicate emails with specific codes", async () => {
    const weak = await h.app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: "weak@example.com", password: "short", displayName: "W" },
    });
    expect(weak.statusCode).toBe(400);
    await h.signUp("dup@example.com");
    const dup = await h.app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: {
        email: "dup@example.com",
        password: "a long and sturdy passphrase",
        displayName: "D",
      },
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe("EMAIL_TAKEN");
  });

  it("registers, resolves the session, lists the personal workspace, logs out", async () => {
    const u = await h.signUp("alice@example.com", "Alice");
    const me = await h.app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { cookie: u.cookie },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.email).toBe("alice@example.com");
    expect(me.json().workspaces).toHaveLength(1);
    expect(me.json().workspaces[0].role).toBe("OWNER");

    const bearer = await h.app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { authorization: `Bearer ${u.accessToken}` },
    });
    expect(bearer.statusCode).toBe(200);

    const bad = await h.app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: "alice@example.com", password: "wrong password here" },
    });
    expect(bad.statusCode).toBe(401);

    const out = await h.app.inject({
      method: "POST",
      url: "/v1/auth/logout",
      headers: { cookie: u.cookie },
    });
    expect(out.statusCode).toBe(204);
    const after = await h.app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { cookie: u.cookie },
    });
    expect(after.statusCode).toBe(401);
  });

  it("refresh rotates tokens and detects reuse", async () => {
    const reg = await h.app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: {
        email: "rot@example.com",
        password: "a long and sturdy passphrase",
        displayName: "Rot",
      },
    });
    const refresh = reg.cookies.find((c) => c.name === "ae_refresh")!.value;
    const r1 = await h.app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      headers: { cookie: `ae_refresh=${refresh}` },
    });
    expect(r1.statusCode).toBe(200);
    const r2 = await h.app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      headers: { cookie: `ae_refresh=${refresh}` },
    });
    expect(r2.statusCode).toBe(401); // reuse of the rotated token invalidates the chain
    const newAccess = r1.json().accessToken as string;
    const me = await h.app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { authorization: `Bearer ${newAccess}` },
    });
    expect(me.statusCode).toBe(401); // whole chain revoked after reuse
  });

  it("answers a question with retrieval, citations, an answer record and telemetry", async () => {
    const u = await h.signUp("bob@example.com", "Bob");
    const note = await h.app.inject({
      method: "POST",
      url: `/v1/workspaces/${u.workspaceId}/knowledge/notes`,
      headers: { cookie: u.cookie },
      payload: {
        title: "Contractor policy memo",
        content:
          "# Contractor policy\n\nThe revised contractor policy took effect in March 2024 and applies to all independent contractors engaged by the company.\n\n## Penalties\n\nPenalties for late training completion are assessed quarterly by the finance team.",
      },
    });
    expect(note.statusCode).toBe(201);
    expect(note.json().knowledge.status).toBe("PENDING");

    // The worker ingests it (chunk + embed through the gateway).
    const job = await h.ctx.jobRunner.runOnce();
    expect(job?.type).toBe("knowledge.ingest");
    const listed = await h.app.inject({
      method: "GET",
      url: `/v1/workspaces/${u.workspaceId}/knowledge`,
      headers: { cookie: u.cookie },
    });
    expect(listed.json().items[0]).toMatchObject({ status: "READY", chunkCount: 1 });

    const conv = await h.app.inject({
      method: "POST",
      url: `/v1/workspaces/${u.workspaceId}/conversations`,
      headers: { cookie: u.cookie },
      payload: {},
    });
    expect(conv.statusCode).toBe(201);
    const conversationId = conv.json().id;

    // Pin the stub so this test isolates the retrieval/citation path; Auto routing and fallback are covered below.
    const models = (
      await h.app.inject({
        method: "GET",
        url: `/v1/workspaces/${u.workspaceId}/models`,
        headers: { cookie: u.cookie },
      })
    ).json().items;
    const stubId = models.find(
      (m: { providerModelName: string }) => m.providerModelName === "dev-echo-1",
    ).id;
    const events = await h.stream(
      `/v1/workspaces/${u.workspaceId}/conversations/${conversationId}/messages`,
      u.cookie,
      {
        content: "When did the contractor policy take effect?",
        modelVersionId: stubId,
      },
    );
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("accepted");
    expect(types).toContain("context");
    expect(types).toContain("model_selected");
    expect(types.filter((t) => t === "delta").length).toBeGreaterThan(3);
    const complete = events.find((e) => e.type === "complete")!;
    expect(complete.answerRecord.disposition).toBe("ANSWERED");
    expect(
      complete.answerRecord.citations.map((c: { label: string; referenced: boolean }) => [
        c.label,
        c.referenced,
      ]),
    ).toEqual([["S1", true]]);
    expect(
      complete.answerRecord.claims.some(
        (c: { claimType: string }) => c.claimType === "SOURCED_FACT",
      ),
    ).toBe(true);
    expect(complete.answerRecord.confidence).toBeGreaterThan(0);
    expect(complete.answerRecord.confidenceBasis).toMatch(/traced to retrieved sources/);
    expect(complete.answerRecord.answerPath.map((s: { step: string }) => s.step)).toEqual(
      expect.arrayContaining([
        "Question received",
        "Model selected",
        "Answer generated",
        "Claims classified",
        "Answer recorded",
      ]),
    );
    expect(complete.modelRuns).toHaveLength(1);
    expect(complete.modelRuns[0]).toMatchObject({ status: "SUCCEEDED", purpose: "ANSWER" });
    expect(complete.modelRuns[0].usage.reported).toBe(true);
    expect(complete.modelRuns[0].estimatedCostUsd).toBeGreaterThan(0);
    const modelSelected = events.find((e) => e.type === "model_selected")!;
    expect(modelSelected.displayName).toBe("Local Development Model (stub)");
    const manifest = events.find((e) => e.type === "context")!.manifest;
    expect(manifest.items.map((i: { kind: string }) => i.kind)).toEqual(
      expect.arrayContaining(["SYSTEM_INSTRUCTION", "KNOWLEDGE_CHUNK", "CONVERSATION_MESSAGE"]),
    );
    expect(manifest.retrieval.method).toBe("hybrid");

    // Persisted conversation view includes the answer record and runs.
    const view = await h.app.inject({
      method: "GET",
      url: `/v1/workspaces/${u.workspaceId}/conversations/${conversationId}`,
      headers: { cookie: u.cookie },
    });
    expect(view.statusCode).toBe(200);
    expect(view.json().messages).toHaveLength(2);
    expect(view.json().messages[1].status).toBe("COMPLETE");
    expect(Object.keys(view.json().answers)).toHaveLength(1);

    // Usage ledger reflects the run.
    const usage = await h.app.inject({
      method: "GET",
      url: `/v1/workspaces/${u.workspaceId}/usage`,
      headers: { cookie: u.cookie },
    });
    expect(usage.json().runs).toBeGreaterThanOrEqual(1);
    expect(usage.json().monthToDateUsd).toBeGreaterThan(0);

    // Audit trail exists and is readable by the owner.
    const audit = await h.app.inject({
      method: "GET",
      url: `/v1/workspaces/${u.workspaceId}/audit`,
      headers: { cookie: u.cookie },
    });
    const eventTypes = audit.json().items.map((a: { eventType: string }) => a.eventType);
    expect(eventTypes).toEqual(
      expect.arrayContaining([
        "knowledge.created",
        "conversation.created",
        "message.created",
        "model_run.finished",
      ]),
    );
  });

  it("falls back to another approved model on a transient provider failure", async () => {
    // dead-provider has the highest routing priority but is unreachable.
    const u = await h.signUp("fallback@example.com");
    const conv = await h.app.inject({
      method: "POST",
      url: `/v1/workspaces/${u.workspaceId}/conversations`,
      headers: { cookie: u.cookie },
      payload: { modelMode: "FRONTIER" },
    });
    const events = await h.stream(
      `/v1/workspaces/${u.workspaceId}/conversations/${conv.json().id}/messages`,
      u.cookie,
      { content: "Explain why fallbacks matter.", useKnowledge: false },
    );
    const selected = events.filter((e) => e.type === "model_selected").map((e) => e.displayName);
    expect(selected[0]).toBe("Dead Model");
    expect(selected[1]).toBe("Local Development Model (stub)");
    expect(
      events.some((e) => e.type === "notice" && /Trying another approved model/.test(e.message)),
    ).toBe(true);
    const complete = events.find((e) => e.type === "complete")!;
    expect(complete.answerRecord.disposition).toBe("ANSWERED");
    expect(complete.modelRuns.map((r: { status: string }) => r.status)).toEqual([
      "FAILED",
      "SUCCEEDED",
    ]);
    expect(complete.answerRecord.limitations.map((l: { kind: string }) => l.kind)).toEqual([
      "FALLBACK_MODEL_USED",
    ]);
  });

  it("classifies a provider refusal as PROVIDER_RESTRICTED, never as the answer", async () => {
    const u = await h.signUp("refuse@example.com");
    const conv = await h.app.inject({
      method: "POST",
      url: `/v1/workspaces/${u.workspaceId}/conversations`,
      headers: { cookie: u.cookie },
      payload: { modelMode: "PRIVATE" },
    });
    const events = await h.stream(
      `/v1/workspaces/${u.workspaceId}/conversations/${conv.json().id}/messages`,
      u.cookie,
      { content: "REFUSE_TEST please", useKnowledge: false },
    );
    const complete = events.find((e) => e.type === "complete")!;
    expect(complete.answerRecord.disposition).toBe("PROVIDER_RESTRICTED");
    expect(complete.answerRecord.content).toBe("");
    expect(complete.assistantMessage.content).toBe("The selected provider declined this request.");
    expect(complete.modelRuns.at(-1).status).toBe("REFUSED");
    expect(complete.answerRecord.limitations[0].kind).toBe("PROVIDER_REFUSED");
  });

  it("reports an unconfigured-only registry as UNSUPPORTED and never leaks credential names", async () => {
    const u = await h.signUp("unconf@example.com");
    const models = await h.app.inject({
      method: "GET",
      url: `/v1/workspaces/${u.workspaceId}/models`,
      headers: { cookie: u.cookie },
    });
    const claude = models
      .json()
      .items.find((m: { providerModelName: string }) => m.providerModelName === "claude-test");
    expect(claude.configured).toBe(false);
    expect(claude.selectable).toBe(false);
    expect(JSON.stringify(models.json())).not.toContain("credentialRef");
    // Pinning the unconfigured model yields UNSUPPORTED, not a fake answer.
    const conv = await h.app.inject({
      method: "POST",
      url: `/v1/workspaces/${u.workspaceId}/conversations`,
      headers: { cookie: u.cookie },
      payload: {},
    });
    const events = await h.stream(
      `/v1/workspaces/${u.workspaceId}/conversations/${conv.json().id}/messages`,
      u.cookie,
      { content: "hello", modelVersionId: claude.id, useKnowledge: false },
    );
    const complete = events.find((e) => e.type === "complete")!;
    expect(complete.answerRecord.disposition).toBe("UNSUPPORTED");
    expect(complete.modelRuns).toHaveLength(0);
  });

  it("compares two models side by side with one record per lane", async () => {
    const u = await h.signUp("compare@example.com");
    const models = (
      await h.app.inject({
        method: "GET",
        url: `/v1/workspaces/${u.workspaceId}/models`,
        headers: { cookie: u.cookie },
      })
    ).json().items;
    const stub = models.find(
      (m: { providerModelName: string }) => m.providerModelName === "dev-echo-1",
    ).id;
    const dead = models.find(
      (m: { providerModelName: string }) => m.providerModelName === "dead-1",
    ).id;
    const conv = await h.app.inject({
      method: "POST",
      url: `/v1/workspaces/${u.workspaceId}/conversations`,
      headers: { cookie: u.cookie },
      payload: {},
    });
    const events = await h.stream(
      `/v1/workspaces/${u.workspaceId}/conversations/${conv.json().id}/compare`,
      u.cookie,
      { content: "Compare please", modelVersionIds: [stub, dead], useKnowledge: false },
    );
    const completes = events.filter((e) => e.type === "complete");
    expect(completes).toHaveLength(2);
    const byLane = Object.fromEntries(completes.map((c) => [c.lane, c.answerRecord.disposition]));
    expect(byLane).toEqual({ 0: "ANSWERED", 1: "FAILED" });
    const view = await h.app.inject({
      method: "GET",
      url: `/v1/workspaces/${u.workspaceId}/conversations/${conv.json().id}`,
      headers: { cookie: u.cookie },
    });
    expect(view.json().messages).toHaveLength(3); // 1 user + 2 assistant lanes
  });

  it("exports account data and processes deletion requests", async () => {
    const u = await h.signUp("export@example.com");
    const exp = await h.app.inject({
      method: "POST",
      url: "/v1/account/export",
      headers: { cookie: u.cookie },
    });
    expect(exp.statusCode).toBe(200);
    expect(exp.json().workspaces).toHaveLength(1);
    const mismatch = await h.app.inject({
      method: "POST",
      url: "/v1/account/delete",
      headers: { cookie: u.cookie },
      payload: { confirmEmail: "other@example.com" },
    });
    expect(mismatch.statusCode).toBe(400);
    const del = await h.app.inject({
      method: "POST",
      url: "/v1/account/delete",
      headers: { cookie: u.cookie },
      payload: { confirmEmail: "export@example.com" },
    });
    expect(del.statusCode).toBe(202);
    const after = await h.app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { cookie: u.cookie },
    });
    expect(after.statusCode).toBe(401);
  });

  it("serves Prometheus metrics", async () => {
    const res = await h.app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("ae_model_runs_total");
    expect(res.body).toContain("ae_authorization_decisions_total");
  });
});
