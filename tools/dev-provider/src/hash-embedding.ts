import { createHash } from "node:crypto";

/**
 * Deterministic hashing embedder for development and tests. It is NOT a
 * semantic embedding: it hashes word unigrams and bigrams into a fixed-size
 * vector (feature hashing) and L2-normalizes, which gives stable, lexical
 * cosine similarity that is good enough to exercise the hybrid retrieval
 * pipeline end to end. Registered as "Local Development Embedder (hashing)",
 * deploymentType LOCAL, evaluationStatus TESTING. Never used in production.
 */
export function hashEmbedding(text: string, dimensions = 1536): number[] {
  const vec = new Float64Array(dimensions);
  const tokens = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
  const features: string[] = [...tokens];
  for (let i = 0; i < tokens.length - 1; i++) features.push(`${tokens[i]}_${tokens[i + 1]}`);
  for (const f of features) {
    const h = createHash("sha1").update(f).digest();
    const idx = h.readUInt32BE(0) % dimensions;
    const sign = h[4]! & 1 ? 1 : -1;
    vec[idx] = (vec[idx] ?? 0) + sign;
  }
  let norm = 0;
  for (let i = 0; i < dimensions; i++) norm += (vec[i] ?? 0) ** 2;
  norm = Math.sqrt(norm) || 1;
  return Array.from(vec, (v) => Math.round((v / norm) * 1e6) / 1e6);
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
    na += (a[i] ?? 0) ** 2;
    nb += (b[i] ?? 0) ** 2;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}
