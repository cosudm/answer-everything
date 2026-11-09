import type { Queryable } from "@ae/database";
import { iso, isoRequired } from "@ae/database";
import type { ResearchStep, ResearchStepKind, ResearchTask } from "@ae/domain";
import { randomUUID } from "node:crypto";

/**
 * Research is a visible multi-step process (Plan -> Sources -> Evidence ->
 * Contradictions -> Claims -> Verification -> Synthesis). The MVP ships the
 * persisted task shape, a deterministic planner that lays out the steps, and
 * the repository. Step execution by the worker is on the roadmap
 * (ROADMAP.md, "Long-running research").
 */

const DEFAULT_PLAN: ResearchStepKind[] = [
  "PLAN",
  "SEARCH_SOURCES",
  "READ_SOURCE",
  "EXTRACT_EVIDENCE",
  "FIND_CONTRADICTIONS",
  "EXTRACT_CLAIMS",
  "VERIFY",
  "SYNTHESIZE",
];

export function planResearch(question: string): ResearchStep[] {
  const taskId = randomUUID();
  return DEFAULT_PLAN.map((kind, ordinal) => ({
    id: randomUUID(),
    taskId,
    ordinal,
    kind,
    status: "PENDING",
    input: ordinal === 0 ? { question } : {},
    output: null,
    modelRunIds: [],
    startedAt: null,
    finishedAt: null,
  }));
}

export async function createResearchTask(
  q: Queryable,
  input: { workspaceId: string; conversationId: string | null; projectId: string | null; actingIdentityId: string; question: string },
): Promise<ResearchTask> {
  const steps = planResearch(input.question);
  const res = await q.query(
    `INSERT INTO research_tasks (workspace_id, conversation_id, project_id, acting_identity_id, question, status, steps)
     VALUES ($1,$2,$3,$4,$5,'QUEUED',$6) RETURNING *`,
    [input.workspaceId, input.conversationId, input.projectId, input.actingIdentityId, input.question, JSON.stringify(steps)],
  );
  return toTask(res.rows[0]);
}

export async function getResearchTask(q: Queryable, id: string): Promise<ResearchTask | null> {
  const res = await q.query("SELECT * FROM research_tasks WHERE id = $1", [id]);
  return res.rows[0] ? toTask(res.rows[0]) : null;
}

function toTask(r: Record<string, unknown>): ResearchTask {
  return {
    id: r.id as string,
    workspaceId: r.workspace_id as string,
    conversationId: (r.conversation_id as string | null) ?? null,
    projectId: (r.project_id as string | null) ?? null,
    actingIdentityId: r.acting_identity_id as string,
    question: r.question as string,
    status: r.status as ResearchTask["status"],
    steps: (r.steps as ResearchStep[]) ?? [],
    answerRecordId: (r.answer_record_id as string | null) ?? null,
    createdAt: isoRequired(r.created_at as string),
    updatedAt: isoRequired(r.updated_at as string),
    finishedAt: iso(r.finished_at as string | null),
  };
}
