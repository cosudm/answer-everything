import type { Queryable } from "@ae/database";
import type { AuditEventType } from "@ae/domain";

export interface AuditInput {
  workspaceId?: string | null;
  actorIdentityId?: string | null;
  actorUserId?: string | null;
  eventType: AuditEventType;
  resourceKind?: string | null;
  resourceId?: string | null;
  outcome: "SUCCESS" | "FAILURE" | "DENIED";
  ipAddress?: string | null;
  userAgent?: string | null;
  details?: Record<string, unknown>;
}

/**
 * Appends an immutable audit event. No RETURNING clause: the audit table's
 * SELECT policy is stricter than its INSERT policy and the caller does not
 * need the id.
 */
export async function recordAudit(q: Queryable, input: AuditInput): Promise<void> {
  await q.query(
    `INSERT INTO audit_events
       (workspace_id, actor_identity_id, actor_user_id, event_type, resource_kind, resource_id,
        outcome, ip_address, user_agent, details)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      input.workspaceId ?? null,
      input.actorIdentityId ?? null,
      input.actorUserId ?? null,
      input.eventType,
      input.resourceKind ?? null,
      input.resourceId ?? null,
      input.outcome,
      input.ipAddress ?? null,
      input.userAgent ? input.userAgent.slice(0, 512) : null,
      JSON.stringify(sanitizeDetails(input.details ?? {})),
    ],
  );
}

/** Never let secrets or raw content into the audit log. */
function sanitizeDetails(details: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(details)) {
    if (/password|secret|token|apikey|api_key|authorization|cookie/i.test(k)) continue;
    if (typeof v === "string" && v.length > 1000) out[k] = v.slice(0, 1000) + "…";
    else out[k] = v;
  }
  return out;
}

export interface AuditQuery {
  workspaceId: string;
  limit?: number;
  before?: string;
}

export async function listAudit(q: Queryable, query: AuditQuery) {
  const res = await q.query(
    `SELECT id, workspace_id, actor_identity_id, actor_user_id, event_type, resource_kind, resource_id,
            outcome, details, created_at
     FROM audit_events
     WHERE workspace_id = $1 AND ($3::timestamptz IS NULL OR created_at < $3)
     ORDER BY created_at DESC LIMIT $2`,
    [query.workspaceId, Math.min(query.limit ?? 50, 200), query.before ?? null],
  );
  return res.rows.map((r) => ({
    id: r.id,
    workspaceId: r.workspace_id,
    actorIdentityId: r.actor_identity_id,
    actorUserId: r.actor_user_id,
    eventType: r.event_type,
    resourceKind: r.resource_kind,
    resourceId: r.resource_id,
    outcome: r.outcome,
    details: r.details,
    createdAt: (r.created_at as Date).toISOString(),
  }));
}
