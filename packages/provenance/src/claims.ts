import type { ClaimType } from "@ae/domain";

export interface ExtractedClaim {
  text: string;
  claimType: ClaimType;
  citationLabels: string[];
  spanStart: number;
  spanEnd: number;
}

const CITATION_RE = /\[(S\d{1,3})(?:\s*,\s*(S\d{1,3}))*\]/g;

/** All distinct citation labels (S1, S2, ...) referenced in a piece of text. */
export function referencedLabels(text: string): string[] {
  const labels = new Set<string>();
  for (const m of text.matchAll(/\[((?:S\d{1,3})(?:\s*,\s*S\d{1,3})*)\]/g)) {
    for (const l of m[1]!.split(",")) labels.add(l.trim());
  }
  return [...labels];
}

/**
 * Splits answer text into material sentences and classifies each one.
 *
 * Deterministic policy (ADR-0009):
 *  - a sentence carrying one or more [S#] markers that match supplied source
 *    labels is a SOURCED_FACT linked to those citations;
 *  - a sentence with recommendation language ("should", "recommend",
 *    "consider") and no citation is a RECOMMENDATION;
 *  - any other sentence, when sources were available, is UNCERTAIN: it was not
 *    traced to a retrieved source and has not been verified;
 *  - when no sources were available at all, claims are not extracted (the
 *    answer is a direct model answer and is labelled as such via limitations).
 *
 * The verification pass (roadmap) upgrades UNCERTAIN claims to INFERENCE,
 * SUPPORTED or CONTRADICTED. Nothing here guesses.
 */
export function extractClaims(content: string, availableLabels: string[]): ExtractedClaim[] {
  if (availableLabels.length === 0) return [];
  const available = new Set(availableLabels);
  const claims: ExtractedClaim[] = [];
  for (const { text, start, end } of splitSentences(content)) {
    // List markers and blockquote prefixes carry facts; strip them. Headings,
    // table rows and code fences are structure, not claims.
    const plain = text
      .replace(CITATION_RE, "")
      .replace(/^(\s*(?:[-*+]|\d+[.)])\s+)+/, "")
      .replace(/^>\s*/, "")
      .replace(/\*\*/g, "")
      .trim();
    if (plain.length < 20 || !/[a-zA-Z]{3,}/.test(plain)) continue;
    if (/^[#|`]/.test(plain)) continue;
    const labels = referencedLabels(text).filter((l) => available.has(l));
    let claimType: ClaimType;
    if (labels.length > 0) claimType = "SOURCED_FACT";
    else if (/\b(should|recommend|consider|suggest|advisable|best to)\b/i.test(plain))
      claimType = "RECOMMENDATION";
    else claimType = "UNCERTAIN";
    claims.push({ text: plain, claimType, citationLabels: labels, spanStart: start, spanEnd: end });
  }
  return claims;
}

interface Sentence {
  text: string;
  start: number;
  end: number;
}

/**
 * Sentence splitter tolerant of markdown. Keeps offsets into the original.
 * A citation marker that follows the terminal punctuation ("... company. [S1]")
 * belongs to the sentence before it and is merged back.
 */
export function splitSentences(content: string): Sentence[] {
  const out: Sentence[] = [];
  // Terminal punctuation may be followed by citation groups, which stay with the sentence.
  const re = /[^.!?\n]+(?:[.!?]+(?:[ \t]*\[S\d{1,3}(?:\s*,\s*S\d{1,3})*\])*(?=\s|$)|\n|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const raw = m[0];
    const trimmedStart = raw.length - raw.trimStart().length;
    const text = raw.trim();
    if (!text) continue;
    const start = m.index + trimmedStart;
    out.push({ text, start, end: start + text.length });
  }
  return out;
}

export interface ConfidenceResult {
  confidence: number | null;
  basis: string | null;
}

/**
 * Evidence coverage, not model certainty. Only meaningful when sources were
 * available; otherwise null (and the UI says so).
 */
export function evidenceConfidence(
  claims: ExtractedClaim[],
  hadSources: boolean,
): ConfidenceResult {
  if (!hadSources) return { confidence: null, basis: null };
  if (claims.length === 0)
    return { confidence: 0, basis: "No material claims could be traced to the retrieved sources." };
  const sourced = claims.filter((c) => c.claimType === "SOURCED_FACT").length;
  const material = claims.filter((c) => c.claimType !== "RECOMMENDATION").length || 1;
  const coverage = sourced / material;
  return {
    confidence: Math.round(coverage * 100) / 100,
    basis: `${sourced} of ${material} material claims are traced to retrieved sources. Claims have not yet been independently verified.`,
  };
}
