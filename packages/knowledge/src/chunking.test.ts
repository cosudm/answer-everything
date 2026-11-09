import { describe, expect, it } from "vitest";
import { chunkText } from "./chunking.js";

describe("chunkText", () => {
  it("returns a single chunk for short text", () => {
    const c = chunkText("Hello world. This is a short note.");
    expect(c).toHaveLength(1);
    expect(c[0]!.ordinal).toBe(0);
    expect(c[0]!.tokenCount).toBeGreaterThan(0);
  });
  it("packs paragraphs and records headings", () => {
    const para = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(20);
    const text = `# Intro\n\n${para}\n\n## Details\n\n${para}\n\n${para}\n\n${para}`;
    const chunks = chunkText(text, { targetChars: 1500, overlapChars: 100 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]!.locator.heading).toBe("Intro");
    expect(chunks.at(-1)!.locator.heading).toBe("Details");
    for (let i = 1; i < chunks.length; i++) expect(chunks[i]!.ordinal).toBe(i);
  });
  it("hard-splits a huge paragraph on sentence boundaries", () => {
    const huge = "Sentence number one is here. ".repeat(400);
    const chunks = chunkText(huge, { targetChars: 1000 });
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(1600);
  });
  it("keeps offsets that point back into the original", () => {
    const text = "First paragraph here.\n\nSecond paragraph follows with more words.";
    const [c] = chunkText(text);
    expect(text.slice(c!.locator.charStart, c!.locator.charEnd)).toContain("Second paragraph");
  });
});
