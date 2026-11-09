import type { Queryable } from "@ae/database";
import type { ModelGateway } from "@ae/model-gateway";
import { recordProvenance } from "@ae/provenance";
import { chunkText } from "./chunking.js";
import { getKnowledgeObject, getKnowledgeText, replaceChunks, updateKnowledgeStatus } from "./repository.js";

export interface IngestOptions {
  knowledgeObjectId: string;
  actingIdentityId: string;
  /** Embedding model to use; null skips vectors (lexical-only retrieval). */
  embeddingModelVersionId: string | null;
  gateway: ModelGateway;
}

/** MIME types the MVP can turn into text without external tooling. */
const SUPPORTED_TEXT_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/html",
  "application/json",
  "text/x-markdown",
]);

export function isSupportedMimeType(mime: string | null): boolean {
  if (!mime) return true;
  return SUPPORTED_TEXT_TYPES.has(mime.split(";")[0]!.trim().toLowerCase()) || mime.startsWith("text/");
}

/**
 * Ingestion pipeline for one knowledge object:
 *   Validate -> (Malware scan: deferred, recorded) -> Extract -> Classify -> Chunk -> Embed -> Provenance -> Index
 * Runs inside the caller's tenant transaction. Binary formats (PDF, DOCX)
 * are recorded as FAILED with an explicit "unsupported format" detail rather
 * than silently indexing nothing.
 */
export async function ingestKnowledgeObject(q: Queryable, opts: IngestOptions): Promise<{ chunkCount: number }> {
  const object = await getKnowledgeObject(q, opts.knowledgeObjectId);
  if (!object) throw new Error(`knowledge object ${opts.knowledgeObjectId} not found`);

  if (!isSupportedMimeType(object.mimeType)) {
    await updateKnowledgeStatus(q, object.id, "FAILED", `Unsupported format ${object.mimeType}. Text extraction for this type is not yet connected.`);
    return { chunkCount: 0 };
  }

  await updateKnowledgeStatus(q, object.id, "EXTRACTING");
  const text = (await getKnowledgeText(q, object.id)) ?? "";
  const cleaned = object.mimeType === "text/html" ? stripHtml(text) : text;
  await recordProvenance(q, {
    workspaceId: object.workspaceId,
    subjectKind: "KNOWLEDGE_OBJECT",
    subjectId: object.id,
    event: "EXTRACTED",
    actorIdentityId: opts.actingIdentityId,
    details: { chars: cleaned.length, mimeType: object.mimeType },
  });

  await updateKnowledgeStatus(q, object.id, "INDEXING");
  const chunks = chunkText(cleaned);
  if (!chunks.length) {
    await updateKnowledgeStatus(q, object.id, "FAILED", "No extractable text.");
    return { chunkCount: 0 };
  }

  let embeddings: Array<number[] | null> = chunks.map(() => null);
  if (opts.embeddingModelVersionId) {
    embeddings = [];
    const batchSize = 32;
    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);
      const res = await opts.gateway.embed({
        modelVersionId: opts.embeddingModelVersionId,
        inputs: batch.map((c) => c.content),
        workspaceId: object.workspaceId,
        actingIdentityId: opts.actingIdentityId,
        informationPrivacyClass: object.privacyClass,
      });
      embeddings.push(...res.vectors);
    }
    await recordProvenance(q, {
      workspaceId: object.workspaceId,
      subjectKind: "KNOWLEDGE_OBJECT",
      subjectId: object.id,
      event: "EMBEDDED",
      actorIdentityId: opts.actingIdentityId,
      modelVersionId: opts.embeddingModelVersionId,
      details: { chunks: chunks.length },
    });
  }

  const stored = await replaceChunks(
    q,
    { id: object.id, workspaceId: object.workspaceId },
    chunks.map((c, i) => ({ ordinal: c.ordinal, content: c.content, tokenCount: c.tokenCount, locator: c.locator, embedding: embeddings[i] ?? null })),
    opts.embeddingModelVersionId,
  );
  await recordProvenance(q, {
    workspaceId: object.workspaceId,
    subjectKind: "KNOWLEDGE_OBJECT",
    subjectId: object.id,
    event: "INDEXED",
    actorIdentityId: opts.actingIdentityId,
    details: { chunks: stored.length, vectors: embeddings.filter(Boolean).length },
  });
  await updateKnowledgeStatus(q, object.id, "READY", null, stored.length);
  return { chunkCount: stored.length };
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<(br|p|div|li|h[1-6]|tr)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
