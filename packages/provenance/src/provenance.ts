import type { Queryable } from "@ae/database";
import { isoRequired } from "@ae/database";
import type { ProvenanceEventKind, ProvenanceRecord, ProvenanceSubjectKind } from "@ae/domain";

export interface ProvenanceInput {
  workspaceId: string;
  subjectKind: ProvenanceSubjectKind;
  subjectId: string;
  event: ProvenanceEventKind;
  actorIdentityId?: string | null;
  sourceKind?: ProvenanceSubjectKind | null;
  sourceId?: string | null;
  modelVersionId?: string | null;
  details?: Record<string, unknown>;
}

export async function recordProvenance(q: Queryable, input: ProvenanceInput): Promise<void> {
  await q.query(
    `INSERT INTO provenance_records
       (workspace_id, subject_kind, subject_id, event, actor_identity_id, source_kind, source_id, model_version_id, details)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      input.workspaceId,
      input.subjectKind,
      input.subjectId,
      input.event,
      input.actorIdentityId ?? null,
      input.sourceKind ?? null,
      input.sourceId ?? null,
      input.modelVersionId ?? null,
      JSON.stringify(input.details ?? {}),
    ],
  );
}

export async function provenanceFor(
  q: Queryable,
  subjectKind: ProvenanceSubjectKind,
  subjectId: string,
): Promise<ProvenanceRecord[]> {
  const res = await q.query(
    `SELECT * FROM provenance_records WHERE subject_kind = $1 AND subject_id = $2 ORDER BY created_at`,
    [subjectKind, subjectId],
  );
  return res.rows.map((r) => ({
    id: r.id,
    workspaceId: r.workspace_id,
    subjectKind: r.subject_kind,
    subjectId: r.subject_id,
    event: r.event,
    actorIdentityId: r.actor_identity_id,
    sourceKind: r.source_kind,
    sourceId: r.source_id,
    modelVersionId: r.model_version_id,
    details: r.details,
    createdAt: isoRequired(r.created_at),
  }));
}
