import http from "node:http";
import { hashEmbedding } from "./hash-embedding.js";

/**
 * Local development provider: an OpenAI-compatible HTTP server that lets the
 * whole Ask pipeline (routing, context manifest, streaming, citations, answer
 * records, cost telemetry) run without external credentials.
 *
 * It is a labelled stub, not a model. Its behaviour is deterministic:
 *  - /v1/chat/completions streams a templated answer that quotes any sources
 *    the platform placed in the system prompt (labelled [S1], [S2], ...) so
 *    the citation path is exercised for real;
 *  - test hooks in the user message drive failure modes:
 *      REFUSE_TEST   -> finish_reason: content_filter (provider refusal)
 *      ERROR_500_TEST-> HTTP 500 (transient provider failure)
 *      RATE_LIMIT_TEST -> HTTP 429
 *      SLOW_TEST     -> 1.5s delay before the first token
 *  - /v1/embeddings returns deterministic hashing embeddings (1536 dims).
 *
 * The registry marks it deploymentType=LOCAL, evaluationStatus=TESTING and the
 * seed skips it when AE_ENV=prod.
 */
export interface DevProviderOptions {
  port?: number;
  host?: string;
  /** Milliseconds between streamed tokens. */
  tokenDelayMs?: number;
  embeddingDimensions?: number;
}

export interface DevProviderServer {
  url: string;
  port: number;
  close(): Promise<void>;
  /** Requests seen, for assertions in tests. Bodies are parsed JSON. */
  requests: Array<{ path: string; body: unknown }>;
}

export async function createDevProviderServer(opts: DevProviderOptions = {}): Promise<DevProviderServer> {
  const tokenDelay = opts.tokenDelayMs ?? 8;
  const dims = opts.embeddingDimensions ?? 1536;
  const requests: DevProviderServer["requests"] = [];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/v1/models") {
      json(res, 200, {
        object: "list",
        data: [
          { id: "dev-echo-1", object: "model", owned_by: "answer-everything-dev" },
          { id: "dev-embed-1536", object: "model", owned_by: "answer-everything-dev" },
        ],
      });
      return;
    }
    if (req.method !== "POST") {
      json(res, 404, { error: { message: "not found" } });
      return;
    }
    const body = await readJson(req);
    requests.push({ path: url.pathname, body });

    if (url.pathname === "/v1/embeddings") {
      const inputs: string[] = Array.isArray(body.input) ? body.input : [String(body.input)];
      json(res, 200, {
        object: "list",
        model: body.model,
        data: inputs.map((text, index) => ({ object: "embedding", index, embedding: hashEmbedding(text, dims) })),
        usage: { prompt_tokens: inputs.reduce((n, t) => n + Math.ceil(t.length / 4), 0), total_tokens: 0 },
      });
      return;
    }

    if (url.pathname !== "/v1/chat/completions") {
      json(res, 404, { error: { message: "not found" } });
      return;
    }

    const messages: Array<{ role: string; content: string }> = body.messages ?? [];
    const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
    const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");

    if (lastUser.includes("ERROR_500_TEST")) {
      json(res, 500, { error: { message: "simulated upstream failure", type: "server_error" } });
      return;
    }
    if (lastUser.includes("RATE_LIMIT_TEST")) {
      json(res, 429, { error: { message: "simulated rate limit", type: "rate_limit_error" } });
      return;
    }
    if (lastUser.includes("AUTH_401_TEST")) {
      json(res, 401, { error: { message: "invalid api key", type: "authentication_error" } });
      return;
    }

    const refused = lastUser.includes("REFUSE_TEST");
    const text = refused ? "" : composeAnswer(lastUser, system);
    const promptTokens = Math.ceil((system.length + messages.map((m) => m.content).join("").length) / 4);
    const completionTokens = Math.ceil(text.length / 4);
    const id = `chatcmpl-dev-${Date.now().toString(36)}`;
    const created = Math.floor(Date.now() / 1000);
    const base = { id, object: "chat.completion.chunk", created, model: body.model ?? "dev-echo-1" };

    if (!body.stream) {
      json(res, 200, {
        ...base,
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: refused ? "content_filter" : "stop" }],
        usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
      });
      return;
    }

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-request-id": id,
    });
    const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    if (lastUser.includes("SLOW_TEST")) await sleep(1500);
    send({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });
    if (!refused) {
      // Stream in word-ish pieces so the UI sees progressive rendering.
      for (const piece of text.match(/\S+\s*|\s+/g) ?? []) {
        send({ ...base, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] });
        if (tokenDelay) await sleep(tokenDelay);
      }
    }
    send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: refused ? "content_filter" : "stop" }] });
    send({ ...base, choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens } });
    res.write("data: [DONE]\n\n");
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : (opts.port ?? 0);
  return {
    url: `http://${opts.host ?? "127.0.0.1"}:${port}/v1`,
    port,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/**
 * Builds a deterministic answer. When the platform supplied sources, each
 * source contributes one sentence with its label so citations resolve.
 */
export function composeAnswer(question: string, system: string): string {
  // Only the block the platform labels as sources counts; instructions that
  // merely mention "[S1]" as an example must not be mistaken for a source.
  const marker = system.indexOf("Sources available for this question");
  const block = marker >= 0 ? system.slice(marker) : "";
  const sources: Array<{ label: string; title: string; body: string }> = [];
  for (const line of block.split("\n")) {
    const head = line.match(/^\[(S\d+)\][ \t]+(.+)$/);
    if (head) sources.push({ label: head[1]!, title: head[2]!.trim(), body: "" });
    else if (sources.length) sources[sources.length - 1]!.body += line + "\n";
  }
  const q = question.replace(/\s+/g, " ").trim().slice(0, 240);
  const lines: string[] = [];
  lines.push(`**Local development model (stub).** This is a templated reply, not a real answer to: “${q}”.`);
  lines.push("");
  if (sources.length) {
    lines.push("Based on the sources supplied by the platform:");
    lines.push("");
    for (const s of sources) {
      const first = firstSentence(s.body);
      lines.push(`- ${first} [${s.label}]`);
    }
    lines.push("");
    lines.push("Statements above that carry a source label were taken from those sources. This sentence has no source and is here so claim classification has something uncited to label.");
  } else {
    lines.push("No workspace sources were supplied for this turn, so there is nothing to cite. In a real deployment a frontier or private model would answer here.");
    lines.push("");
    lines.push("You should connect a real provider in `.env` (for example `ANTHROPIC_API_KEY`) to replace this stub.");
  }
  return lines.join("\n");
}

function firstSentence(text: string): string {
  // Skip markdown headings so the quoted sentence is a statement, not a title.
  const cleaned = text
    .split("\n")
    .filter((l) => !/^\s{0,3}#{1,6}\s/.test(l))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  const m = cleaned.match(/^[^.!?]{10,}[.!?]/);
  const s = (m ? m[0] : cleaned.slice(0, 180)).trim();
  return s.length >= 20 ? s : `${s} (excerpt from the source)`;
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
