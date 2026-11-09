import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GenerationRequest, ModelEvent, ModelVersion, Provider } from "@ae/domain";
import { createDevProviderServer, type DevProviderServer } from "@ae/dev-provider";
import { createLogger } from "@ae/observability";
import { DefaultModelGateway } from "../gateway.js";
import { StaticCredentialBroker } from "../util.js";
import { AnthropicAdapter } from "./anthropic.js";
import { OpenAiCompatibleAdapter } from "./openai-compatible.js";

const now = new Date().toISOString();
const MODEL_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WS = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const IDENT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const RUN = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const provider = (adapter: Provider["adapter"], baseUrl: string): Provider => ({
  id: "p1",
  slug: "test",
  kind: adapter === "anthropic" ? "ANTHROPIC" : "OPENAI_COMPATIBLE",
  adapter,
  displayName: "Test",
  baseUrl,
  credentialRef: "TEST_KEY",
  dataHandling: { trainsOnData: false, retentionDays: 0, region: null },
  enabled: true,
  metadata: {},
  createdAt: now,
  updatedAt: now,
});
const model = (name: string, extra: Partial<ModelVersion> = {}): ModelVersion => ({
  id: MODEL_ID,
  providerId: "p1",
  providerModelName: name,
  displayName: name,
  baseModel: null,
  version: null,
  deploymentType: "LOCAL",
  behavioralProfile: "STANDARD",
  capabilities: ["chat", "streaming"],
  privacyClassesAllowed: ["PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED"],
  evaluationStatus: "APPROVED",
  weightsHash: null,
  adapterIds: [],
  contextWindow: 32000,
  maxOutputTokens: 1024,
  inputCostPerMillion: 1,
  outputCostPerMillion: 2,
  quantization: null,
  license: null,
  intendedUses: [],
  prohibitedUses: [],
  modificationHistory: [],
  embeddingDimensions: null,
  enabled: true,
  metadata: {},
  createdAt: now,
  updatedAt: now,
  ...extra,
});
const request = (content: string, system?: string): GenerationRequest => ({
  modelVersionId: MODEL_ID,
  messages: [{ role: "user", content }],
  system,
  informationPrivacyClass: "INTERNAL",
  modelRunId: RUN,
  workspaceId: WS,
  actingIdentityId: IDENT,
});

async function collect(it: AsyncIterable<ModelEvent>) {
  const events: ModelEvent[] = [];
  for await (const e of it) events.push(e);
  return events;
}

describe("OpenAiCompatibleAdapter against the dev provider", () => {
  let server: DevProviderServer;
  beforeAll(async () => {
    server = await createDevProviderServer({ tokenDelayMs: 0 });
  });
  afterAll(() => server.close());

  const adapter = new OpenAiCompatibleAdapter();
  const ctx = () => ({ provider: provider("openai-compatible", server.url), model: model("dev-echo-1"), apiKey: "k", baseUrl: server.url });

  it("streams deltas, reports usage and ends with stop", async () => {
    const events = await collect(adapter.stream(request("What is the capital of France?"), ctx()));
    expect(events[0]!.type).toBe("start");
    const text = events.filter((e) => e.type === "delta").map((e) => (e as { text: string }).text).join("");
    expect(text).toContain("Local development model");
    const usage = events.find((e) => e.type === "usage") as Extract<ModelEvent, { type: "usage" }>;
    expect(usage.usage.reported).toBe(true);
    expect(usage.usage.inputTokens).toBeGreaterThan(0);
    expect(events.at(-1)).toEqual({ type: "end", finishReason: "stop" });
    const sent = server.requests.at(-1)!.body as { stream: boolean; model: string };
    expect(sent.stream).toBe(true);
    expect(sent.model).toBe("dev-echo-1");
  });

  it("quotes sources placed in the system prompt with their labels", async () => {
    const system = "Sources available for this question (cite by label):\n\n[S1] Policy memo\nThe policy took effect in March 2024 and applies to contractors.\n[S2] FAQ\nPenalties are assessed quarterly by the finance team.";
    const events = await collect(adapter.stream(request("When did the policy start?", system), ctx()));
    const text = events.filter((e) => e.type === "delta").map((e) => (e as { text: string }).text).join("");
    expect(text).toContain("[S1]");
    expect(text).toContain("[S2]");
  });

  it("normalizes a content_filter finish into a refusal event", async () => {
    const events = await collect(adapter.stream(request("REFUSE_TEST please"), ctx()));
    const refusal = events.find((e) => e.type === "refusal") as Extract<ModelEvent, { type: "refusal" }>;
    expect(refusal.refusal.code).toBe("content_filter");
    expect(events.at(-1)).toEqual({ type: "end", finishReason: "refusal" });
  });

  it("normalizes HTTP 500 into a retryable PROVIDER_UNAVAILABLE error", async () => {
    const events = await collect(adapter.stream(request("ERROR_500_TEST"), ctx()));
    const err = events.find((e) => e.type === "error") as Extract<ModelEvent, { type: "error" }>;
    expect(err.error.kind).toBe("PROVIDER_UNAVAILABLE");
    expect(err.error.retryable).toBe(true);
    expect(events.at(-1)).toEqual({ type: "end", finishReason: "error" });
  });

  it("normalizes 401 into AUTHENTICATION and never retries it", async () => {
    const events = await collect(adapter.stream(request("AUTH_401_TEST"), ctx()));
    const err = events.find((e) => e.type === "error") as Extract<ModelEvent, { type: "error" }>;
    expect(err.error).toMatchObject({ kind: "AUTHENTICATION", retryable: false, httpStatus: 401 });
  });

  it("returns embeddings with the configured dimension", async () => {
    const r = await adapter.embed(
      { modelVersionId: MODEL_ID, inputs: ["alpha beta", "gamma"], workspaceId: WS, actingIdentityId: IDENT, informationPrivacyClass: "INTERNAL" },
      { ...ctx(), model: model("dev-embed-1536", { capabilities: ["embeddings"], embeddingDimensions: 1536 }) },
    );
    expect(r.vectors).toHaveLength(2);
    expect(r.vectors[0]).toHaveLength(1536);
    expect(r.inputTokens).toBeGreaterThan(0);
  });

  it("reports health", async () => {
    const h = await adapter.health(ctx());
    expect(h.ok).toBe(true);
  });

  it("gateway: enforces privacy clearance and capability before any network call", async () => {
    const m = model("dev-echo-1", { privacyClassesAllowed: ["PUBLIC"] });
    const gateway = new DefaultModelGateway({
      resolver: { resolve: async () => ({ model: m, provider: provider("openai-compatible", server.url) }) },
      credentials: new StaticCredentialBroker({ TEST_KEY: "k" }),
      logger: createLogger({ name: "test", level: "silent", pretty: false }),
    });
    const before = server.requests.length;
    await expect(collect(gateway.stream(request("hi")))).rejects.toMatchObject({ code: "PRIVACY_CLASS_NOT_ALLOWED" });
    expect(server.requests.length).toBe(before);
  });

  it("gateway: refuses to run when the credential is missing", async () => {
    const gateway = new DefaultModelGateway({
      resolver: { resolve: async () => ({ model: model("dev-echo-1"), provider: provider("openai-compatible", server.url) }) },
      credentials: new StaticCredentialBroker({}),
      logger: createLogger({ name: "test", level: "silent", pretty: false }),
    });
    await expect(gateway.generate(request("hi"))).rejects.toMatchObject({ code: "PROVIDER_UNCONFIGURED" });
  });

  it("gateway: generate() aggregates the stream and estimates cost", async () => {
    const gateway = new DefaultModelGateway({
      resolver: { resolve: async () => ({ model: model("dev-echo-1"), provider: provider("openai-compatible", server.url) }) },
      credentials: new StaticCredentialBroker({ TEST_KEY: "k" }),
      logger: createLogger({ name: "test", level: "silent", pretty: false }),
    });
    const r = await gateway.generate(request("Summarize the memo"));
    expect(r.finishReason).toBe("stop");
    expect(r.text.length).toBeGreaterThan(20);
    expect(r.usage.reported).toBe(true);
    expect(r.estimatedCostUsd).toBeGreaterThan(0);
    expect(r.timeToFirstTokenMs).not.toBeNull();
  });

  it("gateway: budget guard blocks before the call", async () => {
    const gateway = new DefaultModelGateway({
      resolver: { resolve: async () => ({ model: model("dev-echo-1"), provider: provider("openai-compatible", server.url) }) },
      credentials: new StaticCredentialBroker({ TEST_KEY: "k" }),
      budget: { check: async () => ({ allowed: false, remainingUsd: 0, reason: "monthly budget exhausted" }) },
      logger: createLogger({ name: "test", level: "silent", pretty: false }),
    });
    await expect(gateway.generate(request("hi"))).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
  });
});

/* ------------------------------------------------------------------------ */
/* Fake Anthropic Messages API                                               */
/* ------------------------------------------------------------------------ */

function fakeAnthropic(): Promise<{ url: string; close: () => Promise<void>; last: () => any }> {
  let last: any = null;
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    last = { headers: req.headers, body };
    if (req.headers["x-api-key"] !== "sk-test") {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }));
      return;
    }
    const user = body.messages.at(-1).content as string;
    res.writeHead(200, { "content-type": "text/event-stream", "request-id": "req_123" });
    const ev = (type: string, data: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`);
    ev("message_start", { message: { id: "msg_1", usage: { input_tokens: 42, cache_read_input_tokens: 0 } } });
    if (user.includes("OVERLOAD")) {
      ev("error", { error: { type: "overloaded_error", message: "Overloaded" } });
      res.end();
      return;
    }
    if (user.includes("TOOL")) {
      ev("content_block_start", { index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "lookup" } });
      ev("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: '{"q":' } });
      ev("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: '"x"}' } });
      ev("content_block_stop", { index: 0 });
      ev("message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 7 } });
      ev("message_stop", {});
      res.end();
      return;
    }
    ev("content_block_start", { index: 0, content_block: { type: "thinking" } });
    ev("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "considering" } });
    ev("content_block_stop", { index: 0 });
    ev("content_block_start", { index: 1, content_block: { type: "text", text: "" } });
    ev("content_block_delta", { index: 1, delta: { type: "text_delta", text: "Hello " } });
    ev("content_block_delta", { index: 1, delta: { type: "text_delta", text: "world." } });
    ev("content_block_stop", { index: 1 });
    ev("message_delta", { delta: { stop_reason: user.includes("REFUSE") ? "refusal" : "end_turn" }, usage: { output_tokens: 3 } });
    ev("message_stop", {});
    res.end();
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())), last: () => last });
    }),
  );
}

describe("AnthropicAdapter against a fake Messages API", () => {
  let fake: Awaited<ReturnType<typeof fakeAnthropic>>;
  beforeAll(async () => {
    fake = await fakeAnthropic();
  });
  afterAll(() => fake.close());
  const adapter = new AnthropicAdapter();
  const ctx = (apiKey = "sk-test") => ({ provider: provider("anthropic", fake.url), model: model("claude-test"), apiKey, baseUrl: fake.url });

  it("sends system separately, normalizes text, thinking and usage", async () => {
    const events = await collect(adapter.stream(request("hi", "be brief"), ctx()));
    expect(fake.last().body.system).toBe("be brief");
    expect(fake.last().headers["anthropic-version"]).toBeDefined();
    const text = events.filter((e) => e.type === "delta").map((e) => (e as { text: string }).text).join("");
    expect(text).toBe("Hello world.");
    expect(events.some((e) => e.type === "reasoning_delta")).toBe(true);
    const usage = events.find((e) => e.type === "usage") as Extract<ModelEvent, { type: "usage" }>;
    expect(usage.usage).toMatchObject({ inputTokens: 42, outputTokens: 3, reported: true });
    expect((events[0] as { providerRequestId: string }).providerRequestId).toBe("req_123");
    expect(events.at(-1)).toEqual({ type: "end", finishReason: "stop" });
  });

  it("maps stop_reason refusal", async () => {
    const events = await collect(adapter.stream(request("REFUSE"), ctx()));
    expect(events.find((e) => e.type === "refusal")).toMatchObject({ refusal: { source: "stop_reason" } });
    expect(events.at(-1)).toEqual({ type: "end", finishReason: "refusal" });
  });

  it("assembles tool calls from input_json_delta", async () => {
    const events = await collect(adapter.stream(request("TOOL"), ctx()));
    const call = events.find((e) => e.type === "tool_call") as Extract<ModelEvent, { type: "tool_call" }>;
    expect(call.call).toEqual({ id: "toolu_1", name: "lookup", argumentsJson: '{"q":"x"}' });
    expect(events.at(-1)).toEqual({ type: "end", finishReason: "tool_calls" });
  });

  it("maps in-stream overloaded errors to retryable PROVIDER_UNAVAILABLE", async () => {
    const events = await collect(adapter.stream(request("OVERLOAD"), ctx()));
    expect(events.find((e) => e.type === "error")).toMatchObject({ error: { kind: "PROVIDER_UNAVAILABLE", retryable: true } });
    expect(events.at(-1)).toEqual({ type: "end", finishReason: "error" });
  });

  it("maps HTTP 401 to AUTHENTICATION", async () => {
    const events = await collect(adapter.stream(request("hi"), ctx("wrong")));
    expect(events.find((e) => e.type === "error")).toMatchObject({ error: { kind: "AUTHENTICATION", httpStatus: 401 } });
  });
});
