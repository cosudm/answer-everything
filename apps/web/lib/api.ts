import type { AskStreamEvent } from "@ae/domain";

export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000").replace(
  /\/$/,
  "",
);

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
    public readonly requestId?: string,
  ) {
    super(message);
  }
}

/** JSON request against the API with the session cookie. */
export async function api<T>(
  path: string,
  init: RequestInit & { json?: unknown } = {},
): Promise<T> {
  const { json, headers, ...rest } = init;
  const res = await fetch(`${API_URL}${path}`, {
    ...rest,
    credentials: "include",
    headers: {
      ...(json !== undefined ? { "content-type": "application/json" } : {}),
      ...(headers ?? {}),
    },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = data?.error ?? {};
    throw new ApiError(
      res.status,
      err.code ?? "HTTP_ERROR",
      err.message ?? `Request failed (${res.status})`,
      err.details,
      err.requestId,
    );
  }
  return data as T;
}

/**
 * Opens a POST SSE stream and yields parsed AskStreamEvents. Stops when the
 * server closes the stream or the AbortSignal fires.
 */
export async function* streamAsk(
  path: string,
  body: unknown,
  signal?: AbortSignal,
): AsyncGenerator<AskStreamEvent> {
  const res = await fetch(`${API_URL}${path}`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    let err: { code?: string; message?: string } = {};
    try {
      err = JSON.parse(text)?.error ?? {};
    } catch {
      /* not json */
    }
    throw new ApiError(
      res.status,
      err.code ?? "STREAM_FAILED",
      err.message ?? `Stream failed (${res.status})`,
    );
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const data = frame
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      try {
        yield JSON.parse(data) as AskStreamEvent;
      } catch {
        /* ignore malformed frame */
      }
    }
  }
}
