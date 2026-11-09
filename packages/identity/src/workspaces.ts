import type { Queryable } from "@ae/database";
import { iso, isoRequired } from "@ae/database";
import type { Project, Workspace, WorkspaceMembership, WorkspaceRole, WorkspaceSettings } from "@ae/domain";
import { WorkspaceSettings as WorkspaceSettingsSchema } from "@ae/domain";
import { toWorkspace } from "./service.js";

/**
 * Workspace and project repositories. All functions expect a Queryable that
 * is inside `withTenant` (ae_app role + request context) so RLS applies.
 */

export async function listWorkspacesForUser(q: Queryable, userId: string): Promise<Array<Workspace & { role: WorkspaceRole }>> {
  const res = await q.query(
    `SELECT w.*, m.role FROM workspaces w
     JOIN workspace_memberships m ON m.workspace_id = w.id AND m.user_id = $1
     WHERE w.deleted_at IS NULL ORDER BY w.kind = 'PERSONAL' DESC, w.created_at`,
    [userId],
  );
  return res.rows.map((r) => ({ ...toWorkspace(r), role: r.role as WorkspaceRole }));
}

export async function getWorkspace(q: Queryable, workspaceId: string): Promise<Workspace | null> {
  const res = await q.query("SELECT * FROM workspaces WHERE id = $1 AND deleted_at IS NULL", [workspaceId]);
  return res.rows[0] ? toWorkspace(res.rows[0]) : null;
}

export async function getMembership(q: Queryable, workspaceId: string, userId: string): Promise<WorkspaceMembership | null> {
  const res = await q.query("SELECT * FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2", [
    workspaceId,
    userId,
  ]);
  const r = res.rows[0];
  return r
    ? { workspaceId: r.workspace_id, userId: r.user_id, role: r.role, createdAt: isoRequired(r.created_at) }
    : null;
}

export async function createWorkspace(
  q: Queryable,
  input: { name: string; kind: "PERSONAL" | "ORGANIZATION"; ownerUserId: string; slug: string; settings?: Partial<WorkspaceSettings> },
): Promise<Workspace> {
  const settings = WorkspaceSettingsSchema.parse(input.settings ?? {});
  const res = await q.query(
    `INSERT INTO workspaces (slug, name, kind, owner_user_id, settings) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [input.slug, input.name, input.kind, input.ownerUserId, JSON.stringify(settings)],
  );
  const ws = toWorkspace(res.rows[0]);
  await q.query(`INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'OWNER')`, [
    ws.id,
    input.ownerUserId,
  ]);
  return ws;
}

export async function updateWorkspaceSettings(
  q: Queryable,
  workspaceId: string,
  patch: Partial<WorkspaceSettings>,
): Promise<Workspace | null> {
  const current = await getWorkspace(q, workspaceId);
  if (!current) return null;
  const merged = WorkspaceSettingsSchema.parse({ ...current.settings, ...patch });
  const res = await q.query(`UPDATE workspaces SET settings = $2 WHERE id = $1 RETURNING *`, [
    workspaceId,
    JSON.stringify(merged),
  ]);
  return res.rows[0] ? toWorkspace(res.rows[0]) : null;
}

export async function addMember(q: Queryable, workspaceId: string, userId: string, role: WorkspaceRole): Promise<void> {
  await q.query(
    `INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1,$2,$3)
     ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
    [workspaceId, userId, role],
  );
}

/* ------------------------------------------------------------- projects */

function toProject(r: Record<string, unknown>): Project {
  return {
    id: r.id as string,
    workspaceId: r.workspace_id as string,
    name: r.name as string,
    description: (r.description as string | null) ?? null,
    instructions: (r.instructions as string | null) ?? null,
    privacyClass: r.privacy_class as Project["privacyClass"],
    createdByUserId: r.created_by_user_id as string,
    metadata: (r.metadata as Record<string, unknown>) ?? {},
    createdAt: isoRequired(r.created_at as string),
    updatedAt: isoRequired(r.updated_at as string),
    archivedAt: iso(r.archived_at as string | null),
  };
}

export async function listProjects(q: Queryable, workspaceId: string): Promise<Project[]> {
  const res = await q.query(
    "SELECT * FROM projects WHERE workspace_id = $1 AND archived_at IS NULL ORDER BY created_at DESC",
    [workspaceId],
  );
  return res.rows.map(toProject);
}

export async function getProject(q: Queryable, projectId: string): Promise<Project | null> {
  const res = await q.query("SELECT * FROM projects WHERE id = $1", [projectId]);
  return res.rows[0] ? toProject(res.rows[0]) : null;
}

export async function createProject(
  q: Queryable,
  input: {
    workspaceId: string;
    name: string;
    description?: string | null;
    instructions?: string | null;
    privacyClass: Project["privacyClass"];
    createdByUserId: string;
  },
): Promise<Project> {
  const res = await q.query(
    `INSERT INTO projects (workspace_id, name, description, instructions, privacy_class, created_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [input.workspaceId, input.name, input.description ?? null, input.instructions ?? null, input.privacyClass, input.createdByUserId],
  );
  return toProject(res.rows[0]);
}
