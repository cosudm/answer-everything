import { describe, expect, it } from "vitest";
import { parseSse } from "./sse.js";
import { classifyHttpError, estimateCostUsd, looksLikeTextRefusal } from "./util.js";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

async function collect(chunks: string[]) {
  const out = [];
  for await (const m of parseSse(streamOf(chunks))) out.push(m);
  return out;
}

describe("parseSse", () => {
  it("parses events split across chunk boundaries", async () => {
    const msgs = await collect(["event: message_start\ndata: {\"a\":", "1}\n\nda", "ta: second\n\n"]);
    expect(msgs).toEqual([
      { event: "message_start", data: '{"a":1}', id: null },
      { event: null, data: "second", id: null },
    ]);
  });
  it("joins multi-line data and ignores comments and CRLF", async () => {
    const msgs = await collect([": keepalive\r\ndata: line1\r\ndata: line2\r\n\r\n"]);
    expect(msgs[0]!.data).toBe("line1\nline2");
  });
  it("flushes a trailing message without a final blank line", async () => {
    const msgs = await collect(["data: [DONE]"]);
    expect(msgs[0]!.data).toBe("[DONE]");
  });
  it("handles a multi-byte character split across chunks", async () => {
    const bytes = new TextEncoder().encode("data: café\n\n");
    const a = bytes.slice(0, 9);
    const b = bytes.slice(9);
    const out = [];
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(a);
        c.enqueue(b);
        c.close();
      },
    });
    for await (const m of parseSse(stream)) out.push(m);
    expect(out[0]!.data).toBe("café");
  });
});

describe("classifyHttpError", () => {
  it("maps statuses to kinds and retryability", () => {
    expect(classifyHttpError(401, "", null).kind).toBe("AUTHENTICATION");
    expect(classifyHttpError(429, '{"error":{"message":"Rate limit"}}', "r1")).toMatchObject({ kind: "RATE_LIMITED", retryable: true, providerRequestId: "r1" });
    expect(classifyHttpError(429, "insufficient_quota", null).kind).toBe("QUOTA_EXCEEDED");
    expect(classifyHttpError(400, "maximum context length exceeded", null).kind).toBe("CONTEXT_TOO_LONG");
    expect(classifyHttpError(503, "", null)).toMatchObject({ kind: "PROVIDER_UNAVAILABLE", retryable: true });
  });
});

describe("estimateCostUsd", () => {
  const model = { inputCostPerMillion: 10, outputCostPerMillion: 50 } as never;
  it("computes from per-million prices", () => {
    expect(estimateCostUsd(model, { inputTokens: 1_000_000, outputTokens: 100_000, reasoningTokens: null, cachedInputTokens: null, reported: true })).toBe(15);
  });
  it("is null when pricing is unknown", () => {
    expect(estimateCostUsd({ inputCostPerMillion: null, outputCostPerMillion: 1 } as never, { inputTokens: 1, outputTokens: 1, reasoningTokens: null, cachedInputTokens: null, reported: true })).toBeNull();
  });
});

describe("looksLikeTextRefusal", () => {
  it("fires only on short refusal templates", () => {
    expect(looksLikeTextRefusal("I'm sorry, but I can't help with that request.")).toBe(true);
    expect(looksLikeTextRefusal("I can't say for certain, but the evidence suggests three things. " + "x".repeat(400))).toBe(false);
    expect(looksLikeTextRefusal("Paris is the capital of France.")).toBe(false);
  });
});
