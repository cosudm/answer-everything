import type { EmbeddingRequest, GenerationRequest, ModelEvent, TokenUsage } from "@ae/domain";
import { parseSse } from "../sse.js";
import type { AdapterContext, ProviderAdapter } from "../types.js";
import { classifyHttpError, networkError } from "../util.js";

const ANTHROPIC_VERSION = "2023-06-01";

/**
 * Adapter for the Anthropic Messages API (streaming). Normalizes:
 *  - message_start.usage.input_tokens and message_delta.usage.output_tokens -> usage
 *  - content_block_delta text_delta / thinking_delta -> delta / reasoning_delta
 *  - tool_use blocks with input_json_delta -> tool_call
 *  - stop_reason "refusal" -> refusal; "max_tokens" -> length; "tool_use" -> tool_calls
 *  - error events and HTTP errors -> ProviderError
 */
export class AnthropicAdapter implements ProviderAdapter {
  readonly kind = "anthropic" as const;

  async *stream(
    request: GenerationRequest,
    ctx: AdapterContext,
    signal?: AbortSignal,
  ): AsyncIterable<ModelEvent> {
    const fetchImpl = ctx.fetchImpl ?? fetch;
    // Anthropic takes system separately and requires alternating user/assistant turns.
    const messages = request.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content }));
    const systemParts = [
      request.system,
      ...request.messages.filter((m) => m.role === "system").map((m) => m.content),
    ].filter((s): s is string => Boolean(s));
    const body: Record<string, unknown> = {
      model: ctx.model.providerModelName,
      messages,
      max_tokens: request.maxOutputTokens ?? Math.min(ctx.model.maxOutputTokens ?? 4096, 8192),
      stream: true,
    };
    if (systemParts.length) body.system = systemParts.join("\n\n");
    if (request.temperature != null) body.temperature = request.temperature;
    if (request.stop?.length) body.stop_sequences = request.stop;
    if (request.tools?.length) {
      body.tools = request.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }));
    }

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort);
    const timer = setTimeout(
      () => controller.abort(new Error("provider timeout")),
      ctx.timeoutMs ?? 120_000,
    );

    let response: Response;
    try {
      response = await fetchImpl(`${ctx.baseUrl.replace(/\/$/, "")}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          "anthropic-version": ANTHROPIC_VERSION,
          ...(ctx.apiKey ? { "x-api-key": ctx.apiKey } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      yield { type: "error", error: networkError(err) };
      yield { type: "end", finishReason: "error" };
      return;
    }

    const requestId = response.headers.get("request-id") ?? response.headers.get("x-request-id");
    if (!response.ok || !response.body) {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      const text = await response.text().catch(() => "");
      yield { type: "error", error: classifyHttpError(response.status, text, requestId) };
      yield { type: "end", finishReason: "error" };
      return;
    }

    yield { type: "start", providerRequestId: requestId, modelVersionId: ctx.model.id };

    let inputTokens = 0;
    let outputTokens = 0;
    let cachedInput: number | null = null;
    let stopReason: string | null = null;
    let finish: "stop" | "length" | "tool_calls" | "refusal" | "error" | "cancelled" | null = null;
    const blocks = new Map<number, { type: string; id?: string; name?: string; json: string }>();

    try {
      for await (const msg of parseSse(response.body, controller.signal)) {
        if (!msg.data) continue;
        let ev: Record<string, unknown>;
        try {
          ev = JSON.parse(msg.data);
        } catch {
          continue;
        }
        const type = (ev.type as string) ?? msg.event;
        switch (type) {
          case "message_start": {
            const m = ev.message as
              { usage?: { input_tokens?: number; cache_read_input_tokens?: number } } | undefined;
            inputTokens = m?.usage?.input_tokens ?? 0;
            cachedInput = m?.usage?.cache_read_input_tokens ?? null;
            break;
          }
          case "content_block_start": {
            const idx = Number(ev.index ?? 0);
            const cb = ev.content_block as { type: string; id?: string; name?: string } | undefined;
            if (cb) blocks.set(idx, { type: cb.type, id: cb.id, name: cb.name, json: "" });
            break;
          }
          case "content_block_delta": {
            const idx = Number(ev.index ?? 0);
            const d = ev.delta as
              { type: string; text?: string; thinking?: string; partial_json?: string } | undefined;
            if (!d) break;
            if (d.type === "text_delta" && d.text) yield { type: "delta", text: d.text };
            else if (d.type === "thinking_delta" && d.thinking)
              yield { type: "reasoning_delta", text: d.thinking };
            else if (d.type === "input_json_delta" && d.partial_json) {
              const b = blocks.get(idx);
              if (b) b.json += d.partial_json;
            }
            break;
          }
          case "content_block_stop": {
            const idx = Number(ev.index ?? 0);
            const b = blocks.get(idx);
            if (b?.type === "tool_use") {
              yield {
                type: "tool_call",
                call: {
                  id: b.id ?? `toolu_${idx}`,
                  name: b.name ?? "",
                  argumentsJson: b.json || "{}",
                },
              };
            }
            break;
          }
          case "message_delta": {
            const d = ev.delta as { stop_reason?: string | null } | undefined;
            const u = ev.usage as { output_tokens?: number } | undefined;
            if (d?.stop_reason) stopReason = d.stop_reason;
            if (u?.output_tokens != null) outputTokens = u.output_tokens;
            break;
          }
          case "error": {
            const e = ev.error as { type?: string; message?: string } | undefined;
            const overloaded = e?.type === "overloaded_error";
            yield {
              type: "error",
              error: {
                kind: overloaded
                  ? "PROVIDER_UNAVAILABLE"
                  : e?.type === "rate_limit_error"
                    ? "RATE_LIMITED"
                    : "UNKNOWN",
                message: e?.message ?? "provider error",
                httpStatus: null,
                retryable: overloaded || e?.type === "rate_limit_error",
                providerRequestId: requestId,
              },
            };
            finish = "error";
            break;
          }
          case "message_stop":
          case "ping":
          default:
            break;
        }
        if (finish === "error") break;
      }
    } catch (err) {
      yield { type: "error", error: networkError(err) };
      finish = signal?.aborted ? "cancelled" : "error";
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }

    const usage: TokenUsage = {
      inputTokens,
      outputTokens,
      reasoningTokens: null,
      cachedInputTokens: cachedInput,
      reported: true,
    };
    yield { type: "usage", usage };

    if (finish !== "error" && finish !== "cancelled") {
      if (stopReason === "refusal") {
        yield {
          type: "refusal",
          refusal: { code: "refusal", message: null, source: "stop_reason", rawCategory: null },
        };
        finish = "refusal";
      } else if (stopReason === "max_tokens") finish = "length";
      else if (stopReason === "tool_use") finish = "tool_calls";
      else finish = "stop";
    }
    yield { type: "end", finishReason: finish };
  }

  async embed(_request: EmbeddingRequest, _ctx: AdapterContext): Promise<never> {
    throw Object.assign(new Error("Anthropic does not provide an embeddings endpoint"), {
      providerError: {
        kind: "INVALID_REQUEST",
        message: "no embeddings endpoint",
        httpStatus: null,
        retryable: false,
        providerRequestId: null,
      },
    });
  }

  async health(ctx: AdapterContext) {
    const fetchImpl = ctx.fetchImpl ?? fetch;
    const started = Date.now();
    try {
      const response = await fetchImpl(`${ctx.baseUrl.replace(/\/$/, "")}/v1/models`, {
        headers: {
          "anthropic-version": ANTHROPIC_VERSION,
          ...(ctx.apiKey ? { "x-api-key": ctx.apiKey } : {}),
        },
        signal: AbortSignal.timeout(ctx.timeoutMs ?? 10_000),
      });
      return {
        ok: response.ok,
        latencyMs: Date.now() - started,
        detail: response.ok ? null : `HTTP ${response.status}`,
      };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - started, detail: (err as Error).message };
    }
  }
}
