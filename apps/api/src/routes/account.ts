import { withTenant } from "@ae/database";
import { listWorkspacesForUser } from "@ae/identity";
import { recordAudit } from "@ae/provenance";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { clearSessionCookies, clientMeta, principalOf, requireAuth } from "../plugins/auth.js";
import { ApiHttpError } from "../plugins/errors.js";

/**
 * Account-level data governance: export and deletion. Both are self-only
 * (P-SELF) and audited. Export is synchronous JSON for the MVP; large
 * accounts move to the account.export job (roadmap) with a signed download.
 */
export async function accountRoutes(app: FastifyInstance, ctx: AppContext) {
  app.addHook("preHandler", requireAuth);

  app.post("/v1/account/export", async (req, reply) => {
    const p = principalOf(req);
    const base = { userId: p.user.id, identityId: p.actingIdentity.id };
    await withTenant(ctx.db.app, { ...base, workspaceId: null }, (tx) =>
      ctx.authz.require(tx, { userId: p.user.id, actingIdentityId: p.actingIdentity.id, workspaceId: null, action: "account.export", resource: { kind: "ACCOUNT", id: p.user.id, ownerUserId: p.user.id }, purpose: "export", modelVersionId: null, informationPrivacyClass: null }, { ipAddress: req.ip }),
    );
    const workspaces = await withTenant(ctx.db.app, { ...base, workspaceId: null }, (tx) => listWorkspacesForUser(tx, p.user.id));
    const exported: Record<string, unknown>[] = [];
    for (const ws of workspaces.filter((w) => w.role === "OWNER")) {
      const data = await withTenant(ctx.db.app, { ...base, workspaceId: ws.id }, async (tx) => {
        const [conversations, messages, knowledge, answers, runs] = await Promise.all([
          tx.query("SELECT * FROM conversations WHERE workspace_id = $1 AND deleted_at IS NULL", [ws.id]),
          tx.query("SELECT id, conversation_id, role, content, status, created_at FROM messages WHERE workspace_id = $1 ORDER BY created_at", [ws.id]),
          tx.query("SELECT id, kind, title, mime_type, privacy_class, ai_use_permission, tags, text_content, created_at FROM knowledge_objects WHERE workspace_id = $1 AND deleted_at IS NULL", [ws.id]),
          tx.query("SELECT * FROM answer_records WHERE workspace_id = $1", [ws.id]),
          tx.query("SELECT id, model_version_id, purpose, status, usage, estimated_cost_usd, started_at FROM model_runs WHERE workspace_id = $1", [ws.id]),
        ]);
        await recordAudit(tx, { workspaceId: ws.id, actorIdentityId: p.actingIdentity.id, actorUserId: p.user.id, eventType: "account.export_requested", outcome: "SUCCESS", ...clientMeta(req) });
        return { workspace: ws, conversations: conversations.rows, messages: messages.rows, knowledge: knowledge.rows, answers: answers.rows, modelRuns: runs.rows };
      });
      exported.push(data);
    }
    reply.header("content-disposition", `attachment; filename="answer-everything-export-${p.user.id}.json"`);
    return { exportedAt: new Date().toISOString(), user: p.user, workspaces: exported };
  });

  app.post("/v1/account/delete", async (req, reply) => {
    const p = principalOf(req);
    const body = z.object({ confirmEmail: z.string().email() }).parse(req.body);
    if (body.confirmEmail.trim().toLowerCase() !== p.user.email.trim().toLowerCase()) {
      throw new ApiHttpError(400, "CONFIRMATION_MISMATCH", "Type your account email to confirm deletion.");
    }
    await withTenant(ctx.db.app, { userId: p.user.id, workspaceId: null, identityId: p.actingIdentity.id }, async (tx) => {
      await ctx.authz.require(tx, { userId: p.user.id, actingIdentityId: p.actingIdentity.id, workspaceId: null, action: "account.delete", resource: { kind: "ACCOUNT", id: p.user.id, ownerUserId: p.user.id }, purpose: "delete account", modelVersionId: null, informationPrivacyClass: null }, { ipAddress: req.ip });
      await tx.query("UPDATE users SET status = 'PENDING_DELETION' WHERE id = $1", [p.user.id]);
      await recordAudit(tx, { actorIdentityId: p.actingIdentity.id, actorUserId: p.user.id, eventType: "account.deletion_requested", outcome: "SUCCESS", ...clientMeta(req) });
      await ctx.queue.enqueue(tx, { type: "account.delete", actingIdentityId: p.actingIdentity.id, payload: { userId: p.user.id, requestedAt: new Date().toISOString() } });
    });
    await ctx.identity.revokeAllSessions(p.user.id);
    clearSessionCookies(reply);
    return reply.status(202).send({ status: "PENDING_DELETION", note: "Your sessions were revoked. Data purge runs as a background job; see DATA_GOVERNANCE.md for the retention window." });
  });
}
