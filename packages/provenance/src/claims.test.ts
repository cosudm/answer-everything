import { describe, expect, it } from "vitest";
import { evidenceConfidence, extractClaims, referencedLabels, splitSentences } from "./claims.js";

describe("referencedLabels", () => {
  it("finds single and grouped markers", () => {
    expect(referencedLabels("Revenue grew 12% [S1]. Costs fell [S2, S3].")).toEqual([
      "S1",
      "S2",
      "S3",
    ]);
  });
  it("ignores unrelated brackets", () => {
    expect(referencedLabels("see [link](x) and [1]")).toEqual([]);
  });
});

describe("splitSentences", () => {
  it("attaches trailing citation markers to the preceding sentence", () => {
    const s = splitSentences("The policy began in March. [S1] It applies to contractors. [S2, S3]");
    expect(s.map((x) => x.text)).toEqual([
      "The policy began in March. [S1]",
      "It applies to contractors. [S2, S3]",
    ]);
  });
  it("keeps offsets into the original text", () => {
    const text = "First sentence here. Second one!";
    const s = splitSentences(text);
    expect(s).toHaveLength(2);
    expect(text.slice(s[1]!.start, s[1]!.end)).toBe("Second one!");
  });
});

describe("extractClaims", () => {
  const text =
    "The policy took effect in March 2024 [S1]. It applies to all contractors [S2].\n" +
    "You should review the appendix before signing. The exact penalty amount is not stated anywhere.";

  it("returns nothing when no sources were available", () => {
    expect(extractClaims(text, [])).toEqual([]);
  });

  it("classifies sourced, recommendation and uncertain sentences", () => {
    const claims = extractClaims(text, ["S1", "S2"]);
    expect(claims.map((c) => c.claimType)).toEqual([
      "SOURCED_FACT",
      "SOURCED_FACT",
      "RECOMMENDATION",
      "UNCERTAIN",
    ]);
    expect(claims[0]!.citationLabels).toEqual(["S1"]);
    expect(claims[0]!.text).not.toContain("[S1]");
  });

  it("does not link citations to labels that were not supplied", () => {
    const claims = extractClaims("Something happened in 2020 [S9].", ["S1"]);
    expect(claims[0]!.claimType).toBe("UNCERTAIN");
    expect(claims[0]!.citationLabels).toEqual([]);
  });

  it("skips headings but keeps bullet facts", () => {
    const claims = extractClaims(
      "## A heading that is long enough\n- a bullet item of some length [S1]",
      ["S1"],
    );
    expect(claims).toHaveLength(1);
    expect(claims[0]!.claimType).toBe("SOURCED_FACT");
    expect(claims[0]!.text).toBe("a bullet item of some length");
  });
});

describe("evidenceConfidence", () => {
  it("is null without sources", () => {
    expect(evidenceConfidence([], false)).toEqual({ confidence: null, basis: null });
  });
  it("measures coverage of material claims only", () => {
    const claims = extractClaims(
      "Fact one is stated here [S1]. Fact two is not traced anywhere at all. You should check it.",
      ["S1"],
    );
    const r = evidenceConfidence(claims, true);
    expect(r.confidence).toBe(0.5);
    expect(r.basis).toContain("1 of 2");
  });
});
