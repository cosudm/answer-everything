import type { EmbeddingRequest, GenerationRequest, ModelEvent, TokenUsage } from "@ae/domain";
import { parseSse } from "../sse.js";
import type { AdapterContext, ProviderAdapter } from "../types.js";
import { classifyHttpError, networkError } from "../util.js";

/**
 * Adapter for the OpenAI Chat Completions wire protocol. Covers OpenAI,
 * DeepSeek, xAI, Perplexity, vLLM, Ollama, TGI (OpenAI mode), Together,
 * RunPod serverless and the local development provider.
 *
 * Provider-specific extras are handled where they are additive:
 *  - Perplexity returns `citations: [...]` on chunks -> `citation` events
 *  - DeepSeek / vLLM reasoning models return `reasoning_content` -> `reasoning_delta`
 *  - OpenAI `refusal` deltas and `finish_reason: content_filter` -> `refusal`
 */
export class OpenAiCompatibleAdapter implements ProviderAdapter {
  readonly kind = "openai-compatible" as const;

  async *stream(request: GenerationRequest, ctx: AdapterContext, signal?: AbortSignal): AsyncIterable<ModelEvent> {
    const fetchImpl = ctx.fetchImpl ?? fetch;
    const messages = [
      ...(request.system ? [{ role: "system", content: request.system }] : []),
      ...request.messages.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.name ? { name: m.name } : {}),
        ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
      })),
    ];
    const body: Record<string, unknown> = {
      model: ctx.model.providerModelName,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (request.temperature != null) body.temperature = request.temperature;
    if (request.maxOutputTokens != null) body.max_tokens = request.maxOutputTokens;
    if (request.stop?.length) body.stop = request.stop;
    if (request.responseFormat === "json") body.response_format = { type: "json_object" };
    if (request.tools?.length) {
      body.tools = request.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort);
    const timer = setTimeout(() => controller.abort(new Error("provider timeout")), ctx.timeoutMs ?? 120_000);

    let response: Response;
    try {
      response = await fetchImpl(`${ctx.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          ...(ctx.apiKey ? { authorization: `Bearer ${ctx.apiKey}` } : {}),
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

    const requestId = response.headers.get("x-request-id") ?? response.headers.get("request-id");
    if (!response.ok || !response.body) {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      const text = await response.text().catch(() => "");
      const error = classifyHttpError(response.status, text, requestId);
      // Some providers signal policy refusals as HTTP 400 with a content-policy message.
      if (response.status === 400 && /content[_ ]policy|safety|moderation|blocked/i.test(text)) {
        yield { type: "refusal", refusal: { code: "content_policy", message: error.message, source: "http_error", rawCategory: null } };
        yield { type: "end", finishReason: "refusal" };
        return;
      }
      yield { type: "error", error };
      yield { type: "end", finishReason: "error" };
      return;
    }

    yield { type: "start", providerRequestId: requestId, modelVersionId: ctx.model.id };

    let usage: TokenUsage | null = null;
    let finish: "stop" | "length" | "tool_calls" | "refusal" | "error" | "cancelled" | null = null;
    let refusalText = "";
    const toolCalls = new Map<number, { id: string; name: string; args: string }>();
    const seenCitations = new Set<string>();

    try {
      for await (const msg of parseSse(response.body, controller.signal)) {
        if (msg.data === "[DONE]") break;
        let chunk: Record<string, unknown>;
        try {
          chunk = JSON.parse(msg.data);
        } catch {
          continue;
        }
        if (chunk.error) {
          const e = chunk.error as { message?: string; code?: string; type?: string };
          yield { type: "error", error: { kind: "UNKNOWN", message: e.message ?? "provider error", httpStatus: null, retryable: false, providerRequestId: requestId } };
          finish = "error";
          break;
        }
        // Perplexity-style citations
        const cits = (chunk.citations as string[] | undefined) ?? undefined;
        if (Array.isArray(cits)) {
          for (const uri of cits) {
            if (typeof uri === "string" && !seenCitations.has(uri)) {
              seenCitations.add(uri);
              yield { type: "citation", citation: { uri, title: null, excerpt: null, startIndex: null, endIndex: null } };
            }
          }
        }
        if (chunk.usage) {
          const u = chunk.usage as Record<string, number | undefined>;
          usage = {
            inputTokens: u.prompt_tokens ?? 0,
            outputTokens: u.completion_tokens ?? 0,
            reasoningTokens: (u.completion_tokens_details as unknown as { reasoning_tokens?: number } | undefined)?.reasoning_tokens ?? null,
            cachedInputTokens: (u.prompt_tokens_details as unknown as { cached_tokens?: number } | undefined)?.cached_tokens ?? null,
            reported: true,
          };
        }
        const choices = (chunk.choices as Array<Record<string, unknown>> | undefined) ?? [];
        for (const choice of choices) {
          const delta = (choice.delta as Record<string, unknown> | undefined) ?? {};
          if (typeof delta.content === "string" && delta.content.length) yield { type: "delta", text: delta.content };
          if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length) {
            yield { type: "reasoning_delta", text: delta.reasoning_content };
          }
          if (typeof delta.refusal === "string" && delta.refusal.length) refusalText += delta.refusal;
          const tcs = delta.tool_calls as Array<Record<string, unknown>> | undefined;
          if (Array.isArray(tcs)) {
            for (const tc of tcs) {
              const idx = Number(tc.index ?? 0);
              const fn = (tc.function as { name?: string; arguments?: string } | undefined) ?? {};
              const cur = toolCalls.get(idx) ?? { id: (tc.id as string) ?? `call_${idx}`, name: "", args: "" };
              if (tc.id) cur.id = tc.id as string;
              if (fn.name) cur.name += fn.name;
              if (fn.arguments) cur.args += fn.arguments;
              toolCalls.set(idx, cur);
            }
          }
          const fr = choice.finish_reason as string | null | undefined;
          if (fr) {
            if (fr === "content_filter") finish = "refusal";
            else if (fr === "length") finish = "length";
            else if (fr === "tool_calls" || fr === "function_call") finish = "tool_calls";
            else finish = "stop";
          }
        }
      }
    } catch (err) {
      yield { type: "error", error: networkError(err) };
      finish = controller.signal.aborted && signal?.aborted ? "cancelled" : "error";
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }

    for (const [, tc] of toolCalls) yield { type: "tool_call", call: { id: tc.id, name: tc.name, argumentsJson: tc.args } };
    if (usage) yield { type: "usage", usage };
    if (finish === "refusal" || refusalText) {
      yield {
        type: "refusal",
        refusal: { code: finish === "refusal" ? "content_filter" : "refusal", message: refusalText || null, source: "finish_reason", rawCategory: null },
      };
      finish = "refusal";
    }
    yield { type: "end", finishReason: finish ?? "stop" };
  }

  async embed(request: EmbeddingRequest, ctx: AdapterContext) {
    const fetchImpl = ctx.fetchImpl ?? fetch;
    const started = Date.now();
    const response = await fetchImpl(`${ctx.baseUrl.replace(/\/$/, "")}/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(ctx.apiKey ? { authorization: `Bearer ${ctx.apiKey}` } : {}) },
      body: JSON.stringify({ model: ctx.model.providerModelName, input: request.inputs, encoding_format: "float" }),
      signal: AbortSignal.timeout(ctx.timeoutMs ?? 60_000),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const err = classifyHttpError(response.status, text, response.headers.get("x-request-id"));
      throw Object.assign(new Error(`embedding failed: ${err.message}`), { providerError: err });
    }
    const json = (await response.json()) as { data: Array<{ index: number; embedding: number[] }>; usage?: { prompt_tokens?: number } };
    const vectors = [...json.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
    return { vectors, inputTokens: json.usage?.prompt_tokens ?? null, latencyMs: Date.now() - started };
  }

  async health(ctx: AdapterContext) {
    const fetchImpl = ctx.fetchImpl ?? fetch;
    const started = Date.now();
    try {
      const response = await fetchImpl(`${ctx.baseUrl.replace(/\/$/, "")}/models`, {
        headers: ctx.apiKey ? { authorization: `Bearer ${ctx.apiKey}` } : {},
        signal: AbortSignal.timeout(ctx.timeoutMs ?? 10_000),
      });
      return { ok: response.ok, latencyMs: Date.now() - started, detail: response.ok ? null : `HTTP ${response.status}` };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - started, detail: (err as Error).message };
    }
  }
}
