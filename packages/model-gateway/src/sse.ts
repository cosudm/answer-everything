export interface SseMessage {
  event: string | null;
  data: string;
  id: string | null;
}

/**
 * Parses a text/event-stream body into messages. Handles multi-line data,
 * comments, CRLF, and chunk boundaries that split a line or a UTF-8 sequence.
 */
export async function* parseSse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SseMessage> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let event: string | null = null;
  let id: string | null = null;
  let data: string[] = [];

  const flush = (): SseMessage | null => {
    if (data.length === 0 && event === null) return null;
    const msg = { event, data: data.join("\n"), id };
    event = null;
    id = null;
    data = [];
    return msg;
  };

  try {
    while (true) {
      if (signal?.aborted) return;
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        let line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line === "") {
          const msg = flush();
          if (msg) yield msg;
          continue;
        }
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        let value = colon === -1 ? "" : line.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        if (field === "event") event = value;
        else if (field === "data") data.push(value);
        else if (field === "id") id = value;
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      const line = buffer.trim();
      if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    const last = flush();
    if (last) yield last;
  } finally {
    reader.releaseLock();
  }
}
