export interface Chunk {
  ordinal: number;
  content: string;
  tokenCount: number;
  locator: { charStart: number; charEnd: number; heading: string | null };
}

export interface ChunkOptions {
  /** Target size in characters (~4 chars per token). */
  targetChars?: number;
  overlapChars?: number;
  maxChars?: number;
}

/**
 * Paragraph-aware chunker. Splits on blank lines, packs paragraphs up to the
 * target size, carries a small overlap for continuity, and records the
 * nearest preceding markdown heading as a locator so citations can point the
 * user to the right section.
 */
export function chunkText(text: string, opts: ChunkOptions = {}): Chunk[] {
  const target = opts.targetChars ?? 2400;
  const overlap = opts.overlapChars ?? 200;
  const max = opts.maxChars ?? target * 1.5;
  const normalized = text.replace(/\r\n/g, "\n");
  const paragraphs: Array<{ text: string; start: number }> = [];
  const re = /[^\n][\s\S]*?(?=\n\s*\n|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(normalized)) !== null) {
    if (m[0].trim()) paragraphs.push({ text: m[0], start: m.index });
    if (m[0].length === 0) re.lastIndex++;
  }

  const chunks: Chunk[] = [];
  let heading: string | null = null;
  /** Heading in force when the current buffer started. */
  let bufHeading: string | null = null;
  let buf: Array<{ text: string; start: number }> = [];
  let bufLen = 0;

  const flush = () => {
    if (!buf.length) return;
    const first = buf[0]!;
    const last = buf[buf.length - 1]!;
    const content = buf.map((p) => p.text).join("\n\n").trim();
    if (!content) {
      buf = [];
      bufLen = 0;
      return;
    }
    chunks.push({
      ordinal: chunks.length,
      content,
      tokenCount: Math.ceil(content.length / 4),
      locator: { charStart: first.start, charEnd: last.start + last.text.length, heading: bufHeading },
    });
    // overlap: keep the tail of the last paragraph
    const tail = last.text.slice(-overlap);
    buf = tail.length >= 40 && tail !== last.text ? [{ text: tail, start: last.start + last.text.length - tail.length }] : [];
    bufLen = buf.reduce((n, p) => n + p.text.length, 0);
    bufHeading = heading;
  };

  for (const p of paragraphs) {
    const h = p.text.match(/^\s{0,3}#{1,6}\s+(.+)$/m);
    if (h) heading = h[1]!.trim();
    if (!buf.length) bufHeading = heading;
    if (p.text.length > max) {
      // Hard-split a huge paragraph on sentence boundaries.
      flush();
      let cursor = 0;
      while (cursor < p.text.length) {
        let end = Math.min(p.text.length, cursor + target);
        if (end < p.text.length) {
          const slice = p.text.slice(cursor, end);
          const cut = Math.max(slice.lastIndexOf(". "), slice.lastIndexOf("\n"));
          if (cut > target * 0.5) end = cursor + cut + 1;
        }
        buf.push({ text: p.text.slice(cursor, end), start: p.start + cursor });
        bufLen = end - cursor;
        bufHeading = heading;
        flush();
        cursor = end;
      }
      continue;
    }
    if (bufLen + p.text.length > target && buf.length) flush();
    buf.push(p);
    bufLen += p.text.length;
  }
  flush();
  // Drop an overlap-only trailing chunk.
  return chunks.filter((c, i) => i === 0 || c.content.length > 40).map((c, i) => ({ ...c, ordinal: i }));
}
