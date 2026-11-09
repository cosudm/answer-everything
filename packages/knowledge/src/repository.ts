import { createHash } from "node:crypto";
import type { Queryable } from "@ae/database";
import { iso, isoRequired, toVectorLiteral } from "@ae/database";
import type { KnowledgeChunk, KnowledgeKind, KnowledgeObject, KnowledgeStatus, PrivacyClass, SearchHit } from "@ae/domain";

export function toKnowledgeObject(r: Record<string, unknown>): KnowledgeObject {
  return {
    id: r.id as string,
    workspaceId: r.workspace_id as string,
    projectId: (r.project_id as string | null) ?? null,
    kind: r.kind as KnowledgeKind,
    title: r.title as string,
    mimeType: (r.mime_type as string | null) ?? null,
    byteSize: r.byte_size == null ? null : Number(r.byte_size),
    contentHash: (r.content_hash as string | null) ?? null,
    storageKey: (r.storage_key as string | null) ?? null,
    sourceUri: (r.source_uri as string | null) ?? null,
    privacyClass: r.privacy_class as PrivacyClass,
    aiUsePermission: r.ai_use_permission as KnowledgeObject["aiUsePermission"],
    status: r.status as KnowledgeStatus,
    statusDetail: (r.status_detail as string | null) ?? null,
    ownerUserId: r.owner_user_id as string,
    tags: (r.tags as string[]) ?? [],
    chunkCount: Number(r.chunk_count ?? 0),
    metadata: (r.metadata as Record<string, unknown>) ?? {},
    createdAt: isoRequired(r.created_at as string),
    updatedAt: isoRequired(r.updated_at as string),
    archivedAt: iso(r.archived_at as string | null),
    deletedAt: iso(r.deleted_at as string | null),
  };
}

export interface NewKnowledgeObject {
  workspaceId: string;
  projectId?: string | null;
  kind: KnowledgeKind;
  title: string;
  mimeType?: string | null;
  textContent: string;
  sourceUri?: string | null;
  privacyClass: PrivacyClass;
  aiUsePermission: "ALLOW" | "DENY";
  ownerUserId: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export async function insertKnowledgeObject(q: Queryable, input: NewKnowledgeObject): Promise<KnowledgeObject> {
  const bytes = Buffer.byteLength(input.textContent, "utf8");
  const hash = createHash("sha256").update(input.textContent).digest("hex");
  const res = await q.query(
    `INSERT INTO knowledge_objects
       (workspace_id, project_id, kind, title, mime_type, byte_size, content_hash, source_uri, text_content,
        privacy_class, ai_use_permission, status, owner_user_id, tags, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'PENDING',$12,$13,$14) RETURNING *`,
    [
      input.workspaceId,
      input.projectId ?? null,
      input.kind,
      input.title,
      input.mimeType ?? "text/plain",
      bytes,
      hash,
      input.sourceUri ?? null,
      input.textContent,
      input.privacyClass,
      input.aiUsePermission,
      input.ownerUserId,
      input.tags ?? [],
      JSON.stringify(input.metadata ?? {}),
    ],
  );
  return toKnowledgeObject(res.rows[0]);
}

export async function getKnowledgeObject(q: Queryable, id: string): Promise<KnowledgeObject | null> {
  const res = await q.query("SELECT * FROM knowledge_objects WHERE id = $1 AND deleted_at IS NULL", [id]);
  return res.rows[0] ? toKnowledgeObject(res.rows[0]) : null;
}

export async function getKnowledgeText(q: Queryable, id: string): Promise<string | null> {
  const res = await q.query("SELECT text_content FROM knowledge_objects WHERE id = $1 AND deleted_at IS NULL", [id]);
  return res.rows[0]?.text_content ?? null;
}

export interface ListKnowledgeOptions {
  workspaceId: string;
  projectId?: string | null;
  kind?: KnowledgeKind;
  search?: string;
  limit?: number;
}

export async function listKnowledgeObjects(q: Queryable, opts: ListKnowledgeOptions): Promise<KnowledgeObject[]> {
  const res = await q.query(
    `SELECT * FROM knowledge_objects
     WHERE workspace_id = $1 AND deleted_at IS NULL
       AND ($2::uuid IS NULL OR project_id = $2)
       AND ($3::text IS NULL OR kind = $3)
       AND ($4::text IS NULL OR title ILIKE '%' || $4 || '%' OR $4 = ANY(tags))
     ORDER BY created_at DESC LIMIT $5`,
    [opts.workspaceId, opts.projectId ?? null, opts.kind ?? null, opts.search ?? null, Math.min(opts.limit ?? 50, 200)],
  );
  return res.rows.map(toKnowledgeObject);
}

export async function updateKnowledgeStatus(
  q: Queryable,
  id: string,
  status: KnowledgeStatus,
  detail: string | null = null,
  chunkCount?: number,
): Promise<void> {
  await q.query(
    `UPDATE knowledge_objects SET status = $2, status_detail = $3, chunk_count = COALESCE($4, chunk_count) WHERE id = $1`,
    [id, status, detail, chunkCount ?? null],
  );
}

export async function updateKnowledgeObject(
  q: Queryable,
  id: string,
  patch: { title?: string; privacyClass?: PrivacyClass; aiUsePermission?: "ALLOW" | "DENY"; tags?: string[]; projectId?: string | null },
): Promise<KnowledgeObject | null> {
  const res = await q.query(
    `UPDATE knowledge_objects SET
       title = COALESCE($2, title),
       privacy_class = COALESCE($3, privacy_class),
       ai_use_permission = COALESCE($4, ai_use_permission),
       tags = COALESCE($5, tags),
       project_id = CASE WHEN $6::boolean THEN $7::uuid ELSE project_id END
     WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
    [id, patch.title ?? null, patch.privacyClass ?? null, patch.aiUsePermission ?? null, patch.tags ?? null, patch.projectId !== undefined, patch.projectId ?? null],
  );
  return res.rows[0] ? toKnowledgeObject(res.rows[0]) : null;
}

export async function softDeleteKnowledgeObject(q: Queryable, id: string): Promise<boolean> {
  const res = await q.query(`UPDATE knowledge_objects SET deleted_at = now(), status = 'ARCHIVED' WHERE id = $1 AND deleted_at IS NULL`, [id]);
  await q.query(`DELETE FROM knowledge_chunks WHERE knowledge_object_id = $1`, [id]);
  return (res.rowCount ?? 0) > 0;
}

export interface NewChunk {
  ordinal: number;
  content: string;
  tokenCount: number;
  locator: Record<string, unknown> | null;
  embedding: number[] | null;
}

export async function replaceChunks(
  q: Queryable,
  object: { id: string; workspaceId: string },
  chunks: NewChunk[],
  embeddingModelVersionId: string | null,
): Promise<KnowledgeChunk[]> {
  await q.query("DELETE FROM knowledge_chunks WHERE knowledge_object_id = $1", [object.id]);
  const out: KnowledgeChunk[] = [];
  for (const c of chunks) {
    const res = await q.query(
      `INSERT INTO knowledge_chunks
         (knowledge_object_id, workspace_id, ordinal, content, token_count, locator, embedding, embedding_model_version_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7::vector,$8) RETURNING id, created_at`,
      [
        object.id,
        object.workspaceId,
        c.ordinal,
        c.content,
        c.tokenCount,
        c.locator ? JSON.stringify(c.locator) : null,
        c.embedding ? toVectorLiteral(c.embedding) : null,
        embeddingModelVersionId,
      ],
    );
    out.push({
      id: res.rows[0].id,
      knowledgeObjectId: object.id,
      workspaceId: object.workspaceId,
      ordinal: c.ordinal,
      content: c.content,
      tokenCount: c.tokenCount,
      locator: c.locator,
      embeddingModelVersionId,
      createdAt: isoRequired(res.rows[0].created_at),
    });
  }
  return out;
}

export async function getChunk(q: Queryable, chunkId: string): Promise<(KnowledgeChunk & { title: string; privacyClass: PrivacyClass }) | null> {
  const res = await q.query(
    `SELECT c.*, o.title, o.privacy_class FROM knowledge_chunks c JOIN knowledge_objects o ON o.id = c.knowledge_object_id WHERE c.id = $1`,
    [chunkId],
  );
  const r = res.rows[0];
  return r
    ? {
        id: r.id,
        knowledgeObjectId: r.knowledge_object_id,
        workspaceId: r.workspace_id,
        ordinal: r.ordinal,
        content: r.content,
        tokenCount: r.token_count,
        locator: r.locator,
        embeddingModelVersionId: r.embedding_model_version_id,
        createdAt: isoRequired(r.created_at),
        title: r.title,
        privacyClass: r.privacy_class,
      }
    : null;
}

export interface HybridSearchInput {
  workspaceId: string;
  query: string;
  queryEmbedding: number[] | null;
  /** Chunks above this class are excluded in SQL, never post-filtered. */
  maxPrivacyClass: PrivacyClass;
  projectId?: string | null;
  /** Restrict to these objects (attachments). */
  objectIds?: string[] | null;
  limit?: number;
}

const PRIVACY_CASE = `CASE o.privacy_class WHEN 'PUBLIC' THEN 0 WHEN 'INTERNAL' THEN 1 WHEN 'CONFIDENTIAL' THEN 2 ELSE 3 END`;
const PRIVACY_RANK_SQL: Record<PrivacyClass, number> = { PUBLIC: 0, INTERNAL: 1, CONFIDENTIAL: 2, RESTRICTED: 3 };

/**
 * Hybrid retrieval with reciprocal rank fusion. Authorization constraints
 * (workspace via RLS, privacy ceiling, AI-use permission, READY status,
 * project scope) are part of the query so unauthorized chunks are never
 * materialized.
 */
export async function hybridSearch(q: Queryable, input: HybridSearchInput): Promise<SearchHit[]> {
  const limit = Math.min(input.limit ?? 8, 50);
  const candidates = Math.max(limit * 4, 24);
  const filters = `
      c.workspace_id = $1
      AND o.deleted_at IS NULL AND o.status = 'READY' AND o.ai_use_permission = 'ALLOW'
      AND ${PRIVACY_CASE} <= $3
      AND ($4::uuid IS NULL OR o.project_id = $4 OR o.project_id IS NULL)
      AND ($5::uuid[] IS NULL OR o.id = ANY($5))`;
  const res = await q.query(
    `WITH lexical AS (
       SELECT c.id, row_number() OVER (ORDER BY ts_rank_cd(c.tsv, plainto_tsquery('english', $2)) DESC, c.id) AS rank
       FROM knowledge_chunks c JOIN knowledge_objects o ON o.id = c.knowledge_object_id
       WHERE ${filters} AND $2 <> '' AND c.tsv @@ plainto_tsquery('english', $2)
       LIMIT $7
     ),
     vec AS (
       SELECT c.id, row_number() OVER (ORDER BY c.embedding <=> $6::vector, c.id) AS rank
       FROM knowledge_chunks c JOIN knowledge_objects o ON o.id = c.knowledge_object_id
       WHERE ${filters} AND $6::text IS NOT NULL AND c.embedding IS NOT NULL
       ORDER BY c.embedding <=> $6::vector
       LIMIT $7
     ),
     fused AS (
       SELECT COALESCE(l.id, v.id) AS id,
              COALESCE(1.0 / (60 + l.rank), 0) + COALESCE(1.0 / (60 + v.rank), 0) AS score,
              l.rank AS lexical_rank, v.rank AS vector_rank
       FROM lexical l FULL OUTER JOIN vec v ON l.id = v.id
     )
     SELECT f.id AS chunk_id, f.score, f.lexical_rank, f.vector_rank,
            c.content, c.locator, o.id AS object_id, o.title, o.privacy_class
     FROM fused f JOIN knowledge_chunks c ON c.id = f.id JOIN knowledge_objects o ON o.id = c.knowledge_object_id
     ORDER BY f.score DESC, c.ordinal
     LIMIT $8`,
    [
      input.workspaceId,
      input.query,
      PRIVACY_RANK_SQL[input.maxPrivacyClass],
      input.projectId ?? null,
      input.objectIds && input.objectIds.length ? input.objectIds : null,
      input.queryEmbedding ? toVectorLiteral(input.queryEmbedding) : null,
      candidates,
      limit,
    ],
  );
  return res.rows.map((r) => ({
    chunkId: r.chunk_id,
    knowledgeObjectId: r.object_id,
    title: r.title,
    content: r.content,
    privacyClass: r.privacy_class,
    locator: r.locator,
    score: Number(r.score),
    lexicalRank: r.lexical_rank == null ? null : Number(r.lexical_rank),
    vectorRank: r.vector_rank == null ? null : Number(r.vector_rank),
  }));
}
