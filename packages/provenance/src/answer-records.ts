import type { Queryable } from "@ae/database";
import { isoRequired } from "@ae/database";
import type {
  AnswerClaim,
  AnswerDisposition,
  AnswerLimitation,
  AnswerPathStep,
  AnswerRecord,
  Citation,
  CitationSourceKind,
  ClaimType,
} from "@ae/domain";

export interface NewCitation {
  label: string;
  sourceKind: CitationSourceKind;
  sourceId?: string | null;
  knowledgeObjectId?: string | null;
  uri?: string | null;
  title?: string | null;
  excerpt?: string | null;
  locator?: Record<string, unknown> | null;
  relevanceScore?: number | null;
  referenced: boolean;
}

export interface NewClaim {
  text: string;
  claimType: ClaimType;
  /** Labels (e.g. "S1") of citations supporting the claim. Resolved to ids on insert. */
  citationLabels: string[];
  spanStart?: number | null;
  spanEnd?: number | null;
  confidence?: number | null;
}

export interface NewAnswerRecord {
  workspaceId: string;
  conversationId: string;
  messageId: string;
  actingIdentityId: string;
  modelRunIds: string[];
  contextManifestId: string | null;
  disposition: AnswerDisposition;
  content: string;
  confidence: number | null;
  confidenceBasis: string | null;
  limitations: AnswerLimitation[];
  answerPath: AnswerPathStep[];
  citations: NewCitation[];
  claims: NewClaim[];
}

export async function insertAnswerRecord(
  q: Queryable,
  input: NewAnswerRecord,
): Promise<AnswerRecord> {
  const rec = await q.query(
    `INSERT INTO answer_records
       (workspace_id, conversation_id, message_id, acting_identity_id, model_run_ids, context_manifest_id,
        disposition, content, confidence, confidence_basis, limitations, answer_path)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING id, created_at`,
    [
      input.workspaceId,
      input.conversationId,
      input.messageId,
      input.actingIdentityId,
      input.modelRunIds,
      input.contextManifestId,
      input.disposition,
      input.content,
      input.confidence,
      input.confidenceBasis,
      JSON.stringify(input.limitations),
      JSON.stringify(input.answerPath),
    ],
  );
  const answerRecordId: string = rec.rows[0].id;
  const createdAt = isoRequired(rec.rows[0].created_at);

  const citations: Citation[] = [];
  const labelToId = new Map<string, string>();
  for (const c of input.citations) {
    const r = await q.query(
      `INSERT INTO citations
         (workspace_id, answer_record_id, label, source_kind, source_id, knowledge_object_id, uri, title, excerpt,
          locator, relevance_score, referenced)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING id, created_at`,
      [
        input.workspaceId,
        answerRecordId,
        c.label,
        c.sourceKind,
        c.sourceId ?? null,
        c.knowledgeObjectId ?? null,
        c.uri ?? null,
        c.title ?? null,
        c.excerpt ?? null,
        c.locator ? JSON.stringify(c.locator) : null,
        c.relevanceScore ?? null,
        c.referenced,
      ],
    );
    const id: string = r.rows[0].id;
    labelToId.set(c.label, id);
    citations.push({
      id,
      workspaceId: input.workspaceId,
      answerRecordId,
      label: c.label,
      sourceKind: c.sourceKind,
      sourceId: c.sourceId ?? null,
      knowledgeObjectId: c.knowledgeObjectId ?? null,
      uri: c.uri ?? null,
      title: c.title ?? null,
      excerpt: c.excerpt ?? null,
      locator: c.locator ?? null,
      relevanceScore: c.relevanceScore ?? null,
      referenced: c.referenced,
      createdAt: isoRequired(r.rows[0].created_at),
    });
  }

  const claims: AnswerClaim[] = [];
  let ordinal = 0;
  for (const cl of input.claims) {
    const citationIds = cl.citationLabels
      .map((l) => labelToId.get(l))
      .filter((x): x is string => Boolean(x));
    const r = await q.query(
      `INSERT INTO answer_claims
         (answer_record_id, workspace_id, text, claim_type, citation_ids, span_start, span_end, confidence, ordinal)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [
        answerRecordId,
        input.workspaceId,
        cl.text,
        cl.claimType,
        citationIds,
        cl.spanStart ?? null,
        cl.spanEnd ?? null,
        cl.confidence ?? null,
        ordinal++,
      ],
    );
    claims.push({
      id: r.rows[0].id,
      answerRecordId,
      workspaceId: input.workspaceId,
      text: cl.text,
      claimType: cl.claimType,
      citationIds,
      spanStart: cl.spanStart ?? null,
      spanEnd: cl.spanEnd ?? null,
      confidence: cl.confidence ?? null,
      verification: null,
    });
  }

  return {
    id: answerRecordId,
    workspaceId: input.workspaceId,
    conversationId: input.conversationId,
    messageId: input.messageId,
    actingIdentityId: input.actingIdentityId,
    modelRunIds: input.modelRunIds,
    contextManifestId: input.contextManifestId,
    disposition: input.disposition,
    content: input.content,
    claims,
    citations,
    confidence: input.confidence,
    confidenceBasis: input.confidenceBasis,
    limitations: input.limitations,
    answerPath: input.answerPath,
    createdAt,
  };
}

export async function getAnswerRecord(q: Queryable, id: string): Promise<AnswerRecord | null> {
  const rec = await q.query("SELECT * FROM answer_records WHERE id = $1", [id]);
  const r = rec.rows[0];
  if (!r) return null;
  const [cits, cls] = await Promise.all([
    q.query("SELECT * FROM citations WHERE answer_record_id = $1 ORDER BY label", [id]),
    q.query("SELECT * FROM answer_claims WHERE answer_record_id = $1 ORDER BY ordinal", [id]),
  ]);
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    conversationId: r.conversation_id,
    messageId: r.message_id,
    actingIdentityId: r.acting_identity_id,
    modelRunIds: r.model_run_ids,
    contextManifestId: r.context_manifest_id,
    disposition: r.disposition,
    content: r.content,
    confidence: r.confidence,
    confidenceBasis: r.confidence_basis,
    limitations: r.limitations,
    answerPath: r.answer_path,
    createdAt: isoRequired(r.created_at),
    citations: cits.rows.map((c) => ({
      id: c.id,
      workspaceId: c.workspace_id,
      answerRecordId: c.answer_record_id,
      label: c.label,
      sourceKind: c.source_kind,
      sourceId: c.source_id,
      knowledgeObjectId: c.knowledge_object_id,
      uri: c.uri,
      title: c.title,
      excerpt: c.excerpt,
      locator: c.locator,
      relevanceScore: c.relevance_score,
      referenced: c.referenced,
      createdAt: isoRequired(c.created_at),
    })),
    claims: cls.rows.map((c) => ({
      id: c.id,
      answerRecordId: c.answer_record_id,
      workspaceId: c.workspace_id,
      text: c.text,
      claimType: c.claim_type,
      citationIds: c.citation_ids,
      spanStart: c.span_start,
      spanEnd: c.span_end,
      confidence: c.confidence,
      verification: c.verification,
    })),
  };
}
